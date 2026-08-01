# Handoff: gateway-handled auth for app MCP servers & HTTP APIs

You are picking up a design-then-build task on the **Every App v2** platform
(monorepo at `/Users/bensenescu/every-app-workspaces/private-every-app`). This
doc is self-contained; deeper detail lives in the sibling files listed at the
end. Read this fully before touching code.

## The mission

Let external clients authenticate to an app's **MCP server** (Streamable HTTP,
e.g. `https://<app>.<domain>/mcp`) and **HTTP APIs** (`/api/*`) with the
**gateway** handling authentication — so app authors don't roll their own auth.
The trigger: today an MCP client hitting `https://agentic-inbox.thecomeup.cc/mcp`
gets `401`, because the only auth path is a browser session cookie.

A 6-agent design workflow already ran and produced a recommendation. **Your job
is to get Ben's decisions (below) and implement Phase 1**, then Phase 2. Do not
re-litigate the comparison unless you find a real flaw.

## How this project works (conventions)

- **Prototyping phase, single real user.** Bias: delete complexity; keep the
  perimeter's security properties.
- **Locked product requirements** (do not propose cutting): hosted multi-tenant
  orgs, and gateway-as-API-gateway. Hosted = ONE multi-tenant gateway fronting
  many orgs and eventually ~100k **untrusted** apps via Workers for Platforms
  dispatch.
- **Security invariants to preserve:** default-private routing; fail-closed
  identity JWTs; inbound trust-header stripping; private app workers; first-user
  signup lock. The gateway — never the app — is the component allowed to fail
  open.
- **Workflow:** isolated git worktrees, one PR per unit of work; bulk/mechanical
  implementation is delegated to Codex (gpt-5.5) and reviewed (Codex review + a
  Fable pass) before the PR opens. Verify build+tests before reporting done.

## Current-state facts (accurate as of today's main; verify before relying)

Entry point: `handleGatewayRequest()` in `packages/perimeter/src/gateway.ts`.

- **Only auth path today = Better Auth session cookie.**
  `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts` reads the
  cookie via `auth.api.getSession()`, resolves org membership
  (`resolveOrgContext`), yields `AuthenticatedSession {sub, email, orgId,
  orgRole}`. Access check = `session.orgId === app.organizationId` AND a
  `user_app_access` row exists.
- **Identity JWT** is minted per request (`mintIdentityJwt`) and injected as the
  `x-everyapp-identity` header into the proxied request. RS256, `aud = appId`,
  issuer = gateway URL. Apps verify it via the SDK: `requireEveryAppUser(request,
  env)` / `getEveryAppUser(request, env)` (`packages/sdk/src/server`).
- **Inbound header handling** (`packages/perimeter/src/headers.ts`):
  `stripInboundHeaders` deletes `cookie`, `authorization`, and every
  `x-everyapp-*` header. **PR #220 change (merged):** on a **public** manifest
  route the gateway now **forwards the inbound `Authorization` verbatim** to the
  app (`prepareOutboundHeaders(headers, isPublic)`), while still stripping
  `cookie` and all `x-everyapp-*`. On **private** routes `Authorization` is
  stripped. This is directly relevant — see "composition" below.
- **Public routes**: manifest `public: [{ path, methods }]` (methods default
  `["GET"]`); default-private; ambiguous/encoded paths never match; a signed
  `x-everyapp-public` marker JWT is issued for anonymous public hits. CSRF:
  state-changing methods need same-origin; **public route + CSRF fail →
  downgrade to anonymous** (the programmatic/webhook path).
- **Wave 2 primitive (merged, #224) — READ THIS, the design brief got it wrong.**
  The `AppGateway` `WorkerEntrypoint` exists
  (`apps/every-app-gateway/src/server/app-gateway-entrypoint.ts`): apps call the
  gateway's AI proxy over a **service binding** with deploy-time
  `props {organizationId, appId, workerName}`, a per-app provider allowlist, and
  edge key injection. This is **app→gateway** (internal), orthogonal to the
  external-client→gateway auth you're designing — but it's the precedent and it
  shares the identity-JWT plumbing. The `00-current-state-brief.md` file says
  this "doesn't exist"; that is STALE (its grounding read a pre-#224 checkout).
  Everything else in that brief is accurate.
- No API keys / OAuth for external clients exist yet. A Phase-6 MCP-OAuth
  proposal sits unbuilt in `docs/architecture-v2-overview.md`.

**What real MCP clients need:**
- **claude.ai connectors**: REQUIRE the OAuth dance (discovery + Dynamic Client
  Registration + PKCE). The connector UI has **no field for a static bearer** —
  this is the load-bearing constraint.
- **Claude Code / Cursor**: support custom headers (`--header`) *and* OAuth.
- **Generic API / CI clients**: plain `Authorization: Bearer`.

## The recommendation (from the workflow) — a phased, terminate-at-the-gateway path

The four explored designs collapse to **three architectures** (the two static-
bearer variants are the same design). The real fork is *where the credential is
verified*: **A** OAuth AS (gateway-terminated), **B/C** static bearer
(gateway-terminated), **D** decentralized (app verifies a forwarded bearer).

1. **Phase 1 (build first, ~700 LOC): gateway-terminated static bearer.**
   User creates a scoped, revocable token in the gateway admin UI. Client sends
   `Authorization: Bearer <reserved-prefix>...`. The gateway, in a new
   authenticator branch **before** the cookie path, validates the token → does a
   **live `hasAppAccess` re-check every request** → mints the SAME internal
   identity JWT (with a `chan="mcp"`-style claim). Bearer requests are
   CSRF-exempt; the reserved-prefix `Authorization` is consumed and **stripped
   on all routes**. `/mcp` and `/api/*` stay **private**. Reuse the existing
   `app_tokens`/`AppTokenRepository`/`app-token-hash`/`/admin/tokens`
   infrastructure but with **user-principal** semantics in a separate table.
   Unblocks Claude Code, Cursor, and generic/CI clients immediately; near-zero
   app change; fully reversible.
   - NOTE the tension: Wave 2 just deleted the `eat_` *app→gateway* static-token
     plane in favor of bindings. A **user-facing ingress** bearer is a different
     thing — but it must **never** carry a provider/egress scope, or it decays
     back into that retired plane.
2. **Phase 2 (fast-follow): OAuth AS via Cloudflare `workers-oauth-provider`,**
   single `app:use` scope, writing grants into the **same** credential store as
   Phase 1. This is required for exactly one reason: **claude.ai connectors**,
   which can't use a static bearer. Budget the real cost in consent/revocation
   UX and CIMD-SSRF hardening, not the protocol plumbing.
3. **Reject D (decentralized/local-verify) as the default.** For ~100k untrusted
   apps, "author mis-wires the SDK guard → silently open endpoint" is a per-app,
   fail-**open** regression — the inverse of the perimeter thesis. Borrow only
   one idea from it: a 10–30s gateway-side token-validation cache (matching the
   existing 30s org/registry caches) recovers most of its hot-path CPU win while
   staying terminated and fail-closed.
4. **Also ship an SDK `createMcpHandler` (Streamable HTTP) helper.** Auth is
   necessary but not sufficient — the app must implement an MCP handler. Make it
   a shared Phase-1 deliverable.

**Composition with what just merged:**
- Sits strictly **above** the `getAppFetcher`/`APP__` proxy seam — unchanged.
- **PR #220 split by reserved prefix:** Every-App bearers (`eak_`/OAuth) are
  gateway-consumed and stripped on all routes; any *non*-Every-App
  `Authorization` keeps #220's verbatim passthrough for apps running their own
  auth on public routes. Since `/mcp`+`/api/*` stay private, #220 doesn't apply
  there anyway (belt-and-suspenders). One credential space, two disjoint
  namespaces.

## Decisions to get from Ben BEFORE building (or confirm as you go)

1. Is **claude.ai connector** support required for v2 GA, or an acceptable
   fast-follow? (Sets OAuth AS as P0 vs P1; everything else holds either way.)
2. Hold the invariant "the gateway, never the app, is what can fail open"?
   (Yes → D stays rejected.)
3. Is the static bearer a **permanent** product surface, or a bridge to
   deprecate once OAuth+connectors ship? (Governs PAT-management UX / secret-
   scanning investment.)
4. **One** credential store that OAuth grants and static tokens both write into,
   or two? (Recommend one.)
5. Build the AS on `workers-oauth-provider`, or hand-roll it? (Third-party dep on
   the auth perimeter.)
6. Single `app:use` scope now, or per-tool/ToolBus scopes up front?

## Your first moves

1. Read `01-comparison-and-recommendation.md` (the decision doc), then skim the
   four design docs for depth on whichever phase you're building.
2. Confirm the current-state facts against the code (especially the #220
   Authorization-forwarding split and the `AppGateway` precedent).
3. Get Ben's answers to the 6 decisions.
4. Implement **Phase 1** in its own worktree/branch; preserve every invariant
   above; add the auth-branch matrix tests (valid token / wrong app / revoked /
   no-access re-check / reserved-prefix stripped on all routes / bearer CSRF-
   exempt / routes stay private). Then the `createMcpHandler` SDK helper.

## Reference files (in this folder)

- `01-comparison-and-recommendation.md` — the scoring matrix, tradeoff axes,
  phased recommendation, and the 6 decisions. **Start here.**
- `00-current-state-brief.md` — dense current-state auth/perimeter facts with
  `file:line` refs (accurate EXCEPT the §3 "AppGateway doesn't exist" claim —
  see the correction above).
- `design-A-oauth-as.md` — full OAuth 2.1 / MCP-spec Authorization Server design.
- `design-B-pat.md` — gateway-issued scoped API tokens (PAT model).
- `design-C-session-token.md` — session-derived short-lived tokens (bridge).
- `design-D-decentralized.md` — public-route + app-local verify (rejected as
  default; read for the scaling argument and the one borrowed idea).
