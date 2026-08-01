# Every App v2 — Architecture Overview (Diagrams & Workflows)

Companion to [architecture-v2-recommendation.md](./architecture-v2-recommendation.md).
That document is the *decision*; this one is the *picture book*: high-level
architecture, security model, schema changes, local dev, and deployment flows.

---

## 1. High-Level Architecture

### The core idea: one door

Exactly one worker is reachable from the internet — the gateway. Every sub-app
is a private worker with no public hostname. The browser never holds a token;
the gateway terminates the session cookie and injects a short-lived signed
identity JWT into every proxied request.

```
                                  INTERNET
                                     │
            ┌────────────────────────┼─────────────────────────┐
            │                        │                         │
   home.example.com         todo.example.com           admin.example.com
   (login, launcher,        chef.example.com           (registry, deploy API,
    agent chat, /mcp)       *.example.com              OAuth consent, secrets)
            │                        │                         │
            ▼                        ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        GATEWAY WORKER  (the only public worker)         │
│                                                                         │
│  1. Resolve app from Host header (D1 registry)                          │
│  2. Strip inbound Cookie + x-everyapp-* headers                         │
│  3. Authenticate Better Auth session (cookie, Domain=.example.com)      │
│  4. Check org membership + app installed + user has access              │
│  5. Public route?  → allow anonymous, set signed public marker          │
│  6. Mint 120s RS256 identity JWT  (aud=<app>, chan=web|mcp|agent)       │
│  7. getAppFetcher(env, app).fetch(request)   ← THE one seam             │
│  8. Stamp uniform security headers on HTML responses                    │
└───────────────┬─────────────────────────────────┬───────────────────────┘
                │                                 │
     BASIC TIER ($5/mo self-host)      PLATFORM / HOSTED TIER ($25/mo WfP)
     service bindings                  dispatch namespace
                │                                 │
                ▼                                 ▼
   ┌─────────────────────────┐      ┌──────────────────────────────────┐
   │  PRIVATE WORKERS        │      │  DISPATCH NAMESPACE (untrusted)  │
   │  no routes              │      │  t_<tenant>_todo   ──┐           │
   │  workers_dev: false     │      │  t_<tenant>_chef     │ no public │
   │  preview_urls: false    │      │  t_<other>_todo    ──┘ hostnames │
   │                         │      │       │ every fetch() ↓          │
   │  ┌──────┐  ┌──────┐     │      │  ┌─────────────────────────┐     │
   │  │ todo │  │ chef │ ... │      │  │ OUTBOUND WORKER         │     │
   │  │ D1 KV│  │ D1 KV│     │      │  │ egress allowlist        │     │
   │  └──────┘  └──────┘     │      │  │ LLM key injection       │     │
   └─────────────────────────┘      │  │ per-app spend metering  │     │
                                    │  └─────────────────────────┘     │
                                    └──────────────────────────────────┘
```

Inside every sub-app, the entire auth surface:

```ts
export default everyApp(app, { tools });   // verifies JWT, populates c.var.user
```

Client-side auth code: **zero lines**. Same-origin `fetch()` rides the cookie;
the gateway swaps it for the identity header before the app ever sees it.

Mobile follows for free: apps are installable PWAs, and the Expo shell
(`apps/mobile-native`) carries no token logic — native sign-in via the Better
Auth Expo client, an app list from `GET /api/me/apps`, and the session cookie
copied into the WebView cookie jar so embedded apps authenticate like browser
tabs. The v1 machinery (postMessage bridge, `/api/session-token`, weak-origin
allowances) stays deleted; the server re-trusts only the `everyapp://` scheme.

### MCP and the agent: one ToolBus

```
 Claude / MCP client                Gateway AI agent (chat in home shell)
        │                                      │
        │ OAuth 2.1 (workers-oauth-provider:   │ (already inside gateway,
        │  PKCE + dynamic client registration, │  acts on user's behalf)
        │  per-app/per-tool consent scopes)    │
        ▼                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATEWAY  /mcp  ───────────────►  TOOLBUS                       │
│                                   • tool registry (D1)          │
│   MCP token TERMINATES here.      • risk policy: read/write/    │
│   Never forwarded downstream.       destructive (operator-set,  │
│                                     never app-supplied hints)   │
│                                   • audit log (actor,tool,app)  │
│                                   • write tools → confirmation  │
└────────────────────┬────────────────────────────────────────────┘
                     │  fresh internal JWT per call:
                     │  aud=<app>, chan=mcp|agent, act={sub:"mcp:<client>"}
                     ▼
        app's  POST /__everyapp/tools/{list,call}
        (unreachable except via getAppFetcher + valid JWT;
         /__everyapp/* can never be declared public)
```

Apps declare tools in the SDK; the gateway snapshots the catalog at deploy time.
Tool names are namespaced (`todo__create_task`). The agent is *just another
MCP-shaped client* — same registry, same minting path, same audit log.

---

## 2. Security Considerations

### Trust model in one table

| Channel | Authenticated by | Trusted because |
|---|---|---|
| Browser → gateway | Better Auth session cookie | Only the gateway ever sees the cookie |
| Gateway → app | 120s RS256 JWT in `x-everyapp-identity` | App **must** verify: pinned alg+kid, `aud` check, reject `none`. Bare headers are never a trust source |
| MCP client → gateway | OAuth 2.1 access token (hashed in KV) | Terminates at gateway; never passed through (MCP spec requirement) |
| Gateway/agent → app tool | Fresh internal JWT (`chan`, `act` claims) | Minted per call; live org-membership + app-installed check at mint time |
| CLI → gateway | Scoped, hashed, expiring `eak_` deploy token | Device-code flow; replaces raw Cloudflare-token auth (ADR-0002 deleted) |

### What the perimeter enforces (so app authors don't have to)

- **Default-private.** Unauthenticated traffic never invokes app code. A
  vibe-coded app with an unguarded route is *structurally unreachable*, not
  "protected by middleware someone remembered to add."
- **Public routes are explicit, narrow, opt-in.** Declared in
  `everyapp.config.ts`; paths canonicalized **before** glob matching with
  deny-on-ambiguity; `path: "/*"` is a hard error; `/__everyapp/*` can never be
  public. Admin UI shows the installation's entire public surface on one screen;
  hosted abuse controls must be re-added deliberately before metered handlers.
- **CSRF at the edge.** Private non-GET requests require
  `Origin`/`Sec-Fetch-Site` consistent with the app's own subdomain —
  default-deny when absent. A failed CSRF check on a manifest-declared public
  route instead forces the request anonymous and injects only the signed public
  marker, so programmatic webhooks work without exposing member identity. No
  cross-subdomain CORS, ever.
- **Header hygiene.** Inbound `Cookie` and `x-everyapp-*` stripped before
  proxying; identity injected fresh per request.
- **Uniform security headers** stamped on every HTML response: HSTS,
  `X-Content-Type-Options`, `frame-ancestors 'none'`, a CSP floor apps can
  tighten but not remove.
- **Key distribution without egress holes.** Gateway public key *set*
  (current + next) injected as an env var at upload — no runtime JWKS fetch.
  Rotation: pre-publish next key → swap → bulk re-push (automated where the
  gateway is the deployer).
- **Control-plane origin isolation.** Deploy API, registry, OAuth consent and
  secrets UI live on `admin.example.com` — an app XSS is never same-origin
  with the deployer or secret store.
- **Egress control (platform/hosted tier).** Outbound worker default-denies
  fetches outside the manifest `egress` list; LLM provider keys are injected at
  the perimeter so apps never hold AI keys; per-app/per-user spend caps.
- **Tenant scoping (hosted).** Identity JWTs use `aud = t_<tenant>_<app>` so
  dispatch routing is not the only line between tenants; per-tenant D1/KV
  bindings; untrusted-mode cache isolation; tenant secrets envelope-encrypted
  with per-tenant KEKs, isolated from the signing key and platform CF token.

### Accepted residual risks (eyes open)

1. **Agent prompt injection / confused deputy** — contained (risk classes,
   write confirmations, per-app tool enablement, untrusted tool output), not
   eliminated. Industry-unsolved.
2. **Cross-app GET-with-side-effects under XSS** — the shared parent-domain
   cookie means an XSS'd app can fire authenticated GETs at siblings. Damped by
   CSP, SDK lint, and `aud` binding. Accepted at consumer scale.
3. **DO-originated fetches bypass the outbound worker** (Cloudflare platform
   gap) — flagged by deploy-time lint, documented, not pretended away.
4. **Basic tier has no egress firewall** — it's the user's own blast radius;
   stated plainly, and the honest upsell to the platform tier.
5. **Revocation latency ≤120s** within the identity-token window.

---

## 3. Schema Changes

Current gateway D1 (Drizzle, `apps/every-app-gateway/src/db/`): Better Auth
tables (`users`, `organizations`, …), `apps`, `user_app_access`, `app_tokens`,
onboarding tables.

### Modified: `apps` (becomes the routing + policy registry)

```
apps
 ├─ id, organization_id, app_id, name, description     (unchanged)
 ├─ app_url, dev_url                                   ─── REMOVED (apps have no
 │                                                          public URL; dev is local)
 ├─ hostname            TEXT NOT NULL UNIQUE           ─── NEW  "todo.example.com"
 ├─ worker_name         TEXT NOT NULL                  ─── NEW  script / binding name
 ├─ tier                TEXT NOT NULL                  ─── NEW  'service_binding' | 'dispatch'
 ├─ manifest            TEXT NOT NULL  (JSON)          ─── NEW  snapshot of
 │                                                          everyapp.config.ts at deploy
 ├─ status              TEXT NOT NULL                  ─── NEW  'active' | 'disabled' | 'deploying'
 └─ is_default, created_at, updated_at                 (unchanged)
```

### New tables

```
app_public_routes                      ── compiled from manifest for fast lookup
 ├─ app_id → apps.id
 ├─ path_glob, methods (JSON)
 └─ rate_limit_rps, aggregate_budget

app_tools                              ── tool catalog, snapshotted at deploy
 ├─ app_id → apps.id
 ├─ tool_name            "todo__create_task"
 ├─ description          (treated as untrusted content)
 ├─ risk_class           'read' | 'write' | 'destructive'   ← operator-controlled;
 │                                                            app manifest only *proposes*
 └─ enabled              per-app explicit enablement

tool_grants                            ── per-user / per-client tool policy
 ├─ user_id, app_id, tool_name (or wildcard)
 ├─ channel              'mcp' | 'agent'
 ├─ client_id            (for MCP grants; NULL for agent)
 └─ granted_at, revoked_at             ← revoked on uninstall / org removal

audit_log                              ── every tool call, every deploy
 ├─ actor ('user:x' | 'mcp:<client>' | 'gateway-agent'), chan
 ├─ tool_name, app_id, organization_id
 └─ decision ('allowed'|'denied'|'confirmed'), created_at

tenants                                ── hosted tier; self-hosted = one row
 ├─ id, name, plan, dispatch_prefix    "t_<tenant>"
 └─ kek_id                             per-tenant envelope-encryption key ref
```

### Repurposed / replaced

- **`app_tokens`** — already hashed + prefixed + scoped; becomes the storage
  for `eak_` **deploy tokens** (scopes `apps:register`, `apps:deploy`),
  issued via device-code flow. Raw-Cloudflare-token auth and `/api/internal/*`
  are deleted (ADR-0002 superseded).
- **MCP OAuth state** (clients, grants, hashed access/refresh tokens) lives in
  **KV** via `workers-oauth-provider` (`OAUTH_KV`) — not D1.

### What needs no migration

`users`, `organizations`, `user_app_access`, sessions — Better Auth is
unchanged. The existing RS256 keypair and JWKS are reused for identity JWTs.

---

## 4. Local Dev Workflow (`everyapp dev`)

The rule that fixes v1's core sin: **dev and prod share the same auth path.**
No fake tokens, no bypassed middleware — a real (local) gateway runs the real
perimeter against your app.

```
 $ everyapp dev
      │
      ▼
┌─────────────────────────── miniflare (multi-worker) ───────────────────────┐
│                                                                            │
│   GATEWAY-LITE  (version-pinned to your deployed gateway)                  │
│   • real perimeter: public-route policy, header strip/inject, CSRF rules   │
│   • seeded dev user + org  (local D1)                                      │
│   • mints REAL identity JWTs with a local dev keypair                      │
│            │                                                               │
│            │  service binding (local)                                      │
│            ▼                                                               │
│   YOUR APP  (hot reload)                                                   │
│   • everyApp() verifies the JWT exactly as in prod                         │
│   • local D1 / KV / DO, auto-migrated                                      │
└────────────────────────────────────────────────────────────────────────────┘
      │
      ▼
 http://localhost:8787          → launcher (logged in as dev user)
 http://todo.localhost:8787     → your app, through the real perimeter
```

- **$0 until first deploy** — everything runs locally.
- Public routes, tool mounting, and header stripping are *exercised locally*,
  so "works on my machine, 401s in prod" can't happen.
- Dev-identity machinery is **compile-time excluded** from prod bundles.
- Gateway-lite checks its version against your deployed gateway at startup and
  warns on skew.

What's deleted vs. today: no `.env.local` gateway URLs, no `VITE_GATEWAY_URL`,
no devUrl registration in the gateway, no postMessage shims.

### Parallel instances per worktree (portless)

[portless](https://github.com/vercel-labs/portless) (Vercel Labs) replaces
ports with named `*.localhost` URLs and **auto-prefixes the git branch name in
linked worktrees** — so every worktree gets its own full gateway+apps instance:

```
 main worktree:        $ everyapp dev   →  https://everyapp.localhost
                                           https://todo.everyapp.localhost
 worktree on fix-ui:   $ everyapp dev   →  https://fix-ui.everyapp.localhost
                                           https://todo.fix-ui.everyapp.localhost
```

Two design requirements make this Just Work:

1. The CLI honors the `PORT` env var when starting miniflare (portless assigns it).
2. The dev gateway parses Host dynamically — first label = app, remainder =
   base host — never a hardcoded `localhost:8787`.

Each worktree has its own `.wrangler` state (local D1/KV) and its own cookie
scope (`Domain=.fix-ui.everyapp.localhost`), so instances are fully isolated —
no port juggling, no shared sessions. Portless's local CA also gives real
HTTPS, so `Secure` cookies and the production CSRF rules run locally too.

---

## 5. Deployment Workflow for New Apps

`everyapp.config.ts` is the single source of truth in both tiers — app id,
resources (D1/KV/DO), public routes, tools + proposed risk classes, egress list.
No `wrangler.jsonc` in app repos (the CLI compiles the manifest to an ephemeral
wrangler config internally).

### One-time: CLI auth (both tiers)

```
 $ everyapp login
      │  device-code flow against the gateway
      ▼
 gateway issues eak_… deploy token (scoped, hashed, expiring)
 — the CLI never sends a Cloudflare token to the gateway, in any tier —
```

### Basic tier ($5/mo self-host) — CLI-as-deployer

```
 $ everyapp create todo            $ everyapp deploy
      │                                 │
      ▼                                 ▼
 scaffold app +              ① compile everyapp.config.ts
 everyapp.config.ts             → ephemeral wrangler config
                                        │
                             ② create D1/KV/DO + deploy worker
                                YOUR CF token (stays on laptop,
                                scoped: Workers/D1/KV edit only)
                                deployed PRIVATE:
                                  no routes
                                  workers_dev: false
                                  preview_urls: false
                                gateway public KEY SET → env var
                                        │
                             ③ POST /api/registry/apps  (eak_ token)
                                manifest + worker_name
                                → gateway writes registry row
                                        │
                             ④ gateway reconstructs its service
                                bindings FROM THE REGISTRY
                                (source of truth + optimistic
                                concurrency — no clobber, no races)
                                        │
                             ⑤ live at todo.example.com
                                (wildcard DNS already → gateway)

 $ everyapp doctor      ← anytime: reconcile registry vs CF state,
                          probe every app for accidental public exposure
```

### Platform / hosted tier ($25/mo WfP) — gateway-as-deployer

```
 $ everyapp deploy
      │
      ▼
 ① CLI bundles code + manifest
      │
      ▼
 ② upload to gateway deploy API  (admin.example.com, eak_ token)
    — developer holds NO Cloudflare token at all —
      │
      ▼
 ③ gateway (CF token lives HERE, as a worker secret — the one place):
    • provisions per-tenant D1/KV via CF API
    • PUT script into dispatch namespace (WfP REST API):
        name: t_<tenant>_todo
        bindings: tenant's resources only
        tags: [tenant-id, app-id]
        env: gateway key set
        secrets: envelope-encrypted per-tenant KEK
    • first upload is SYNCHRONOUS → 200 = live
      │
      ▼
 ④ registry row activates routing — NO binding step exists
    (dispatcher.get(name) is dynamic by name)
      │
      ▼
 ⑤ live at todo-<tenant>.everyapp.host
    (single-label wildcard; BYO domains via CF for SaaS, hostname→tenant in KV)
```

The two tiers share the manifest, the CLI surface, the registry, and every line
of gateway runtime code. They differ only in *who pushes code and who holds the
CF token* — "shared runtime, forked deploy plane," accepted explicitly in the
recommendation (and why basic tier's lifespan is Open Question 3 there).
