# Every App v2 — Testing & Verification

This document covers (A) running the automated suites, (B) local manual
testing via `everyapp dev`, and (C) production verification + rollback.

The v2 security perimeter is the part that must never regress, so its tests are
the priority. Where a step is not yet automated, it says so explicitly.

---

## A. Automated test suites

Each package has a `test` script (vitest). From the repo root:

```bash
pnpm install
pnpm test          # runs `pnpm -r --no-bail run test` across all packages
```

### What is green today

| Package | Suite | Covers |
|---|---|---|
| `packages/sdk` | `src/**/*.test.ts` (49) | fail-closed identity verification: alg/kid pinning, `alg:none`, algorithm-confusion (HS256-with-public-key), wrong key, expiry, audience mismatch, missing claims, public-route handling, `everyApp()` handler wrapper |
| `apps/every-app-gateway` | `src/v2/**/*.test.ts` (70) | public-route glob matching incl. path-traversal + percent-encoding (`/p/%2e%2e/__everyapp/...`), header stripping, security headers, CSRF default-deny, JWT mint, Host parsing, the full `handleGatewayRequest` proxy core, the dev gateway-lite, and an end-to-end perimeter↔real-SDK integration test |
| `apps/every-app-gateway` | legacy `src/**/*.test.ts` | pre-existing gateway tests (still green) |
| `packages/cli` | `src/v2/*.test.ts` (7) | manifest validation (catch-all / `/__everyapp` hard errors) and the ephemeral-wrangler compiler (private-worker flags, resource→binding mapping) |

Run a single layer:

```bash
# Perimeter + integration (gateway)
( cd apps/every-app-gateway && pnpm exec vitest run src/v2 )

# SDK identity verifier
( cd packages/sdk && pnpm test )

# CLI manifest/compiler
( cd packages/cli && pnpm test )
```

### Typecheck / build

```bash
( cd apps/every-app-gateway && pnpm run types:check )   # clean
( cd packages/sdk && pnpm run types:check && pnpm run build )   # clean
( cd packages/cli && pnpm run types:check )             # clean
```

> **Honest status:** the legacy gateway control plane (iframe embed,
> `/api/session-token`, postMessage/expo machinery, `app_url`/`dev_url`
> columns) is **deleted**, and the production worker entry
> (`apps/every-app-gateway/src/server.ts`) now routes app subdomains through
> the v2 perimeter; `everyapp app deploy` ships private workers and
> `everyapp gateway deploy --domain` wires the wildcard routing. Remaining
> follow-up: migrate `apps/workout-tracker`, `apps/chef`, and `templates/*` to
> the v2 SDK/manifest (todo-app is migrated), per Phase 3 of
> `docs/architecture-v2-recommendation.md §6`. The v2 model is proven
> end-to-end by `apps/every-app-gateway/src/v2/integration/e2e.test.ts`.

### The end-to-end perimeter test (the headline)

`src/v2/integration/e2e.test.ts` wires the **real** gateway proxy core to a
**real** sub-app built with the **real** `@every-app/sdk` `everyApp()` over an
in-process service binding, and asserts:

- (a) a logged-in request reaches the app with a **verified** identity;
- (b) a request straight to the app worker (no gateway) yields **401**;
- (c) a declared public route works unauthenticated; everything else 401s;
- (d) `/__everyapp/*` is unreachable unauthenticated, but reachable *with* a
  valid identity (the MCP path);
- (e) the inbound `Cookie` and a spoofed `x-everyapp-identity` are
  stripped/replaced before the app sees the request.

---

## B. Local testing with `everyapp dev`

`everyapp dev` runs the app's own `vite dev` server on an internal loopback
port and a **gateway-lite Node proxy** in front of it on `$PORT` (default
8787). The proxy runs the **real** perimeter (`handleGatewayRequest`, imported
from `every-app-gateway/v2/dev`): real public-route policy, real header
strip/inject, a real RS256 identity JWT signed by a persistent local dev
keypair (`.everyapp/dev-keys.json`, gitignored), CSRF rules, security headers,
and a seeded dev user (`dev@everyapp.localhost`, org `dev-org`, role `owner`).
Hot reload is untouched — vite runs normally; only ingress goes through the
perimeter. The dev gateway module is dev-only and excluded from production
bundles.

On first run the CLI writes `EVERYAPP_IDENTITY_PUBLIC_KEYS` into the app's
`.everyapp/.dev.vars` next to the generated Wrangler config (single dotenv-safe
line; PEM newlines are JSON-escaped), which the Cloudflare vite plugin loads
into the worker env — the SDK verifies real signatures in dev, on the same code
path as production.

### Walkthrough (verified end-to-end on `apps/todo-app`)

1. **Build the CLI once** (monorepo):

   ```bash
   pnpm -C packages/sdk build && pnpm -C packages/cli build
   ```

2. **Run dev** from the app directory:

   ```bash
   cd apps/todo-app
   pnpm exec everyapp dev          # honors $PORT (portless assigns it); --port works too
   ```

   First run only: apply local D1 migrations once the dev server is up
   (`pnpm run db:migrate:local` in a second terminal).

   The dev gateway parses the Host header dynamically (first label = app,
   remainder = base host), so all of these route to the same app with no
   hardcoded base host:

   - `http://todo.localhost:8787/` (browsers resolve `*.localhost` natively;
     for curl add `--connect-to todo.localhost:8787:127.0.0.1:8787`)
   - `http://todo.fix-ui.everyapp.localhost/` (portless, per-worktree)

   Each git worktree gets its own `.wrangler` state and dev keypair, so several
   full gateway+app instances run side by side.

3. **You are already “logged in”** as the seeded dev user — every proxied
   request carries a freshly-minted identity JWT. The perimeter probes (all
   verified against the running todo-app):

   ```bash
   C="--connect-to todo.localhost:8787:127.0.0.1:8787"

   # Through the gateway → 200 HTML, security headers + dev CSP stamped
   curl -s $C -o /dev/null -w '%{http_code}\n' http://todo.localhost:8787/   # 200

   # Direct to the internal vite port (printed at startup) → fail-closed 401
   curl -s http://127.0.0.1:<vite-port>/                                     # 401

   # Spoofed identity header, direct to the app → still 401 (signature fails)
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H 'x-everyapp-identity: forged' http://127.0.0.1:<vite-port>/          # 401

   # POST without an Origin header → CSRF default-deny
   curl -s $C -o /dev/null -w '%{http_code}\n' \
     -X POST http://todo.localhost:8787/anything                             # 403

   # Unknown app label → 404 from the registry
   curl -s -o /dev/null -w '%{http_code}\n' \
     --connect-to nosuch.localhost:8787:127.0.0.1:8787 \
     http://nosuch.localhost:8787/                                           # 404

   # /api/sync without a WebSocket upgrade → 426 (identity verified, handler hit)
   curl -s $C -o /dev/null -w '%{http_code}\n' \
     http://todo.localhost:8787/api/sync                                     # 426
   ```

4. **WebSocket sync (UserSyncDO) through the proxy.** Open the app in two tabs;
   a change in one appears in the other. WebSocket upgrades (app sync *and*
   vite HMR) are raw-piped at the socket level with the perimeter contract
   applied at the upgrade hop: Cookie / Authorization / `x-everyapp-*` stripped,
   a fresh identity JWT injected. `handleSyncWebSocket` gets the verified user
   from `everyApp()` and keys the per-user DO from `user.id` — no token in the
   URL anymore. (Verified: raw 101 handshake through the dev gateway reaches
   the DO.)

5. **Run the suites** as in section A.

### Mirror mode (`--mode mirror`) — real login against a local gateway

`stub` mode (above) fakes the session with a seeded dev user — zero setup,
right for building your app. `mirror` mode swaps in a **real Better Auth
session** so you can exercise the actual login/launcher and org membership.
The session source is the only thing that changes: the perimeter, identity
JWT, CSRF, and header-strip are identical in both modes.

The session knob is a local variable — `--mode` or `EVERYAPP_DEV_MODE` (flag
wins). Mirror does **not** spawn or mount anything in the gateway; it points
at a **separately-running** local gateway and forwards login/launcher traffic
to it.

**Why a two-label base host.** The session cookie is set when you log in at the
gateway base host and must ride to the app subdomain — that requires the cookie
be scoped to a shared parent domain (exactly the production model). So mirror
mode needs a two-label base like `everyapp.localhost` (not bare `localhost`).
The CLI refuses a one-label base with setup guidance.

**Setup (one-time):**

1. Point a two-label host at loopback — portless (recommended) gives
   `*.everyapp.localhost`, or add `/etc/hosts` entries for
   `everyapp.localhost` and `<app>.everyapp.localhost`.
2. In the **gateway's** dev env (`apps/every-app-gateway/.dev.vars`):
   ```
   EVERYAPP_DEV_COOKIE_DOMAIN=everyapp.localhost
   GATEWAY_URL=http://everyapp.localhost:8787
   ```
   (`EVERYAPP_DEV_COOKIE_DOMAIN` enables cross-subdomain cookies — dev-gated;
   `import.meta.env.DEV` is `false` in a production build so prod cookie scope
   is never widened. `GATEWAY_URL` is the origin the browser actually uses —
   the base host the CLI serves, not `:3000`.)

**Run (two terminals):**

```bash
# Terminal 1 — the real gateway (Better Auth, launcher, admin, D1)
cd apps/every-app-gateway && pnpm dev          # serves on :3000

# Terminal 2 — your app behind the perimeter, mirror auth
cd apps/todo-app
pnpm exec everyapp dev --mode mirror --baseHost everyapp.localhost
# (--gateway http://localhost:3000 by default; the CLI fails fast with
#  guidance if the gateway isn't reachable)
```

Open `http://everyapp.localhost:8787` → the **real** gateway launcher/login is
forwarded through. Sign up (the first user becomes the org owner; later signups
are invite-only), make sure you have an active organization, then open
`http://todo.everyapp.localhost:8787` — you reach the app as your **real**
logged-in user.

**Verified end-to-end** (against a stand-in gateway, via `Host:` headers):

| Probe | Result |
|---|---|
| base host `everyapp.localhost:8787/` | real gateway launcher forwarded through |
| `todo.everyapp.localhost:8787/` with a session cookie | **200** — real session resolved, dev-kid identity minted for the real user, app verifies |
| same, no cookie | **401** — perimeter fail-closed |
| one-label base (`localhost:8787`) | **421** with setup guidance |
| direct hit to the app's internal vite port | **401** |

**What's dev-permissive (and why):** per-app access (`user_app_access`) is not
enforced yet — any authenticated user with an active org reaches their
in-development app. Real per-app authorization lands with the Phase-5
app-registration flow; until then mirror gives you a real *identity*, not real
*access control*. The dev identity endpoint (`/api/dev/identity`) and the
cross-subdomain cookie config are both gated to dev builds and 404 / no-op in
production.

### Known follow-ups

- `everyapp dev` currently targets the monorepo (the CLI bundles the gateway's
  dev module via a workspace dependency). For the published npm CLI this is
  fine — tsup inlines it — but keep the gateway export (`./v2/dev`) stable.

---

## C. Production verification

### Deploy checklist

1. **Gateway** owns the wildcard custom domain (`*.example.com` → gateway) and
   holds the RS256 keypair (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`, kid
   `everyapp-identity`).
2. **Each app** is deployed PRIVATE from its manifest:
   - `everyapp deploy` compiles `everyapp.config.ts` → ephemeral wrangler config
     with `workers_dev:false`, `preview_urls:false`, **no routes**;
   - the gateway’s public **key set** is injected as
     `EVERYAPP_IDENTITY_PUBLIC_KEYS` (JSON array, current + next);
   - pending D1 migrations auto-apply;
   - the app row is written to the registry (`apps.hostname`, `worker_name`,
     `tier`, `manifest`, `status`) via the `eak_` deploy-token endpoint;
   - the gateway reconstructs its service bindings **from the registry**.

### Probes — prove a sub-app is NOT directly reachable

```bash
# 1. workers.dev must be disabled — expect DNS failure / no such host
curl -sS https://every-todo.<account>.workers.dev/ ; echo "exit=$?"
# => could not resolve host / 404 — there is no public hostname

# 2. A request that bypasses the gateway gets 401 from the SDK (fail-closed):
#    hit the app via any path that is NOT the gateway and you cannot produce a
#    valid x-everyapp-identity (you don't hold the private key).
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-everyapp-identity: forged.header.value' \
  https://todo.example.com.invalid/   # any non-gateway entry
# => 401

# 3. Through the gateway, a private route without a session redirects/401s:
curl -s -o /dev/null -w '%{http_code}\n' https://todo.example.com/tasks
# => 401 (or 302 to home login for an HTML navigation)

# 4. A declared public route responds without auth:
curl -s -o /dev/null -w '%{http_code}\n' https://todo.example.com/health
# => 200

# 5. The internal namespace is never public:
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://todo.example.com/__everyapp/tools/call
# => 401

# 6. Uniform security headers are stamped on HTML:
curl -sI https://todo.example.com/ | grep -iE \
  'strict-transport-security|x-content-type-options|content-security-policy'
# => HSTS, nosniff, CSP with frame-ancestors 'none'
```

### Confirm the registry / binding state

```bash
# The gateway reconstructs bindings from the registry on every deploy.
# Verify the app row exists and is active:
everyapp doctor        # (deferred in v2.0) — until then, inspect the apps table:
#   SELECT app_id, hostname, worker_name, tier, status FROM apps;
```

### Roll back a bad gateway deploy

The gateway is the single public worker, so a bad gateway deploy is the only
change that can affect every app at once. The proxy core is small and
slow-changing; recover with Cloudflare’s instant rollback:

```bash
# List recent gateway deployments and roll back to the previous good one:
npx wrangler deployments list  --name every-app-gateway
npx wrangler rollback <DEPLOYMENT_ID> --name every-app-gateway
```

Sub-apps are unaffected by a rollback (their workers and the registry are
unchanged); only the perimeter reverts. Because identity tokens live ≤120s,
revocation/identity changes converge within that window.
