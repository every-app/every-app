# v2 Refactor Recommendations

Synthesized from a 7-lens review (3 Fable architecture/API lenses, 2 independent
gpt-5.5 sweeps, a Cloudflare-idioms lens, a docs lens) run 2026-07-07 against
the four v2-cutover commits. Recommendations only — nothing here is applied.
Verdict up front: the security core (perimeter proxy, fail-closed SDK
verification) is sound and none of this touches the trust model. The wounds are
at boundaries: module/package layout, a protocol duplicated by convention,
competing sources of truth in the deploy plane, and v1 subsystems still
squatting next to v2.

## Tier 1 — structural; do these before more code accretes

### 1. Extract the perimeter into a real package and kill the "v2" name
Found independently by three lenses. `src/v2` is written as a dependency-light,
DI'd library but lives inside a deployable app, and the CLI already
deep-imports the app's raw source via the `"./v2/dev"` package export —
inverted layering (CLI → app) that also bundles app source into the published
CLI. And "v2" is a chronological name: v1 is deleted, v2 IS the product; in six
months nobody will know whether new code belongs in `v2/` or `server/`.

**Do:** `packages/perimeter` (or `gateway-core`): proxy core, host, csrf,
headers, publicRoutes, manifest, registry/session interfaces, dev gateway, test
helpers. The gateway app keeps only its adapters (`d1Registry`, the Better Auth
authenticator — rename `prod/authenticator.ts` → `betterAuthAuthenticator.ts`;
it's named for its environment, not what it is). CLI and gateway both take it as
a normal workspace dep with one deliberate `index.ts` surface.

### 2. One source of truth for the wire protocol
The gateway's `identityJwt.ts` and the SDK's `identity.ts` mirror each other
with "must match" comments: header names, kid, alg, claim shapes, marker
subject. The CLI and gateway also mirror the manifest schema (that drift
already broke registration once, live). Colocate mint + verify over one
constants/claims module — natural home is the perimeter package from #1 (or a
tiny `packages/identity-protocol`); tests become mint→verify round-trips
instead of two mirrors. While in there: retire the v1 kid `embedded-app-key-1`
for a v2 name at the next rotation, and pin token TYPE cryptographically (a
`typ`/purpose claim) so the identity JWT and the public marker can never be
confused even though one key signs both.

### 3. Registration becomes a service; cut over to deploy tokens
`register.ts` is ~150 lines of registry policy (hostname derivation, collision
rules, create-vs-update, owner auto-grant) inlined in a route handler — the
exact seam where dispatch tier, status transitions, and doctor-reconciliation
will land — and it validates appId with a *different regex* than the manifest.
Meanwhile the whole `/api/internal` surface authenticates by probing Cloudflare
with the caller's raw CF token (including a CREATE/DROP TABLE probe against
prod D1), which the architecture doc explicitly supersedes with `eak_` deploy
tokens — and `app_tokens` already stores exactly that shape.

**Do:** `AppRegistrationService` owning all registry-write policy (route =
parse → call → serialize); manifest id validator becomes the only appId rule.
Then the deploy-token cutover now, while there are two apps and one CLI:
`/api/deploy/*` authenticated by hashed scoped `eak_` tokens, delete
`internal-cloudflare-auth.ts` (236 lines that get more expensive to remove
every week). CLI side: one typed `lib/gateway/api.ts` client (getIdentityKeys,
registerApp, provisionAppToken, hasOwner, listOrganizations) replacing the four
scattered hand-rolled fetchers — makes the auth swap a one-file change.

### 4. One config model for apps: the manifest generates the wrangler input
Two lenses independently called the dual deploy path (vite-built config patched
private vs manifest-compiled fallback) a top wound, and apps currently author
BOTH `everyapp.config.ts` and `wrangler.jsonc`. Best resolution found: the CLI
(or a tiny everyapp vite plugin) generates a gitignored
`.everyapp/wrangler.json` from the manifest for dev/build, and deploy ships the
built output. One authored file (the manifest), one derivation, no committed
wrangler.jsonc in app repos (restoring the original design), and
`patchBuiltWranglerConfig`'s reconcile-failure class disappears. Also
centralize `resourceNameFor`/the `every-` prefix — currently duplicated.

### 5. Single owner for gateway service bindings
Three competing sources of truth today (repo wrangler.jsonc `services: []`,
app-deploy PATCH with inherit+retry, gateway-deploy registry reconstruction) —
and a bare `wrangler deploy` from the repo would silently sever every app's
binding. **Do:** one `computeGatewayServiceBindings(registry)` used by both
paths; app deploy PATCHes the full recomputed list (idempotent — deletes the
inherit-merge/retry/jitter machinery); a guard that refuses bare `wrangler
deploy` for the gateway. Consider a reserved namespace for app bindings
(`APP__<worker>`) so registry values can never address gateway-owned bindings;
rename the KV binding `every-app-gateway` (hyphenated, misleading) to `KV`.
Note: when the dispatch-namespace tier lands, `dispatcher.get(name)` deletes
this entire problem class — an argument for not over-polishing it.

## Tier 2 — the SDK as a public API (app-author DX)

6. **`everyApp(manifest, …)`** — every entry file writes `{ appId: manifest.id }`;
   pass the manifest itself.
7. **Ship the user-access helpers.** Every app hand-rolls the same
   double-verifying `ensureUser` middleware, and identity.ts's docstring even
   references a `getEveryAppUser` that doesn't exist. Export
   `getEveryAppUser(request, env)` / `requireEveryAppUser(request, env)`
   (WeakMap the verified result per Request and re-verify from env on a cache
   miss), update templates to use them.
8. **Type the boundary.** `everyApp` erases Workers types
   (`Record<string, unknown>` env, `unknown` ctx) forcing double-casts in every
   app; `GatewayDeps.env` has the same problem gateway-side. Generic
   `everyApp<Env>` + a typed fetcher lookup.
9. **Narrow the npm surface.** The SDK currently exports protocol internals and
   test knobs (`now`, kid constants, `parsePublicKeys`) as public API; keep
   `everyApp` + the two user helpers + `IdentityError`, move the rest to an
   internal subpath.
10. **Distinguish misconfiguration from auth failure.** A missing/malformed
    public-key env var surfaces as the same 401 as a forged token; config
    errors should be loud 500s with actionable messages.
11. **EVERYAPP_IDENTITY_ISSUER is injected but never read** — either verify
    `iss` in the SDK (do this) or stop injecting it.
12. **Fix the Hono branch** — `everyApp(app)` mutates the passed app and
    depends on middleware-registration order (fail-open shape if an app adds
    routes before wrapping). Wrap, don't mutate.

## Tier 3 — runtime/ops hygiene and leftovers

13. **Registry read path:** implement `D1AppRegistry` with Drizzle against the
    shared schema (today: hand-written SQL + hand-mapped aliases beside a
    Drizzle repo on the same table). Make unknown `status` fail CLOSED — the
    current fallback coerces unknown values to `"active"`, i.e. routable.
14. **Hot-path costs:** per-isolate TTL cache for hostname→app lookups (every
    app request pays a D1 query) and for public-marker JWTs (every anonymous
    public hit pays an RSA sign for a marker with no per-request content).
15. **Observability:** structured request logging at the perimeter (app, user,
    status, duration) and stamp `observability.enabled` into deployed app
    configs; single source for compatibility_date (CLI hardcodes a stale one).
16. **Decide the AI-proxy/app-token subsystem's fate.** It's a second,
    v1-shaped trust model (long-lived `x-every-app-token` secrets, apps calling
    the control-plane origin) beside v2's "apps hold no credentials" — and
    `gateway-auth-policy.ts` misleadingly names the AI-proxy check, not the
    gateway's policy. Either port it to the perimeter key-injection model
    (design §2.3) or explicitly quarantine it as legacy until Phase 6.
17. Consolidate the three "which org is this session acting under"
    implementations (middleware, perimeter authenticator, Better Auth hooks)
    into one resolver.
18. Small: delete dead `--repo` flag + stale docs on gateway deploy; split the
    dev command's god module; dedupe manifest loading (deploy vs dev);
    single-source `every-app.jsonc` removal (already queued); stray v1 files
    (`components/`, `hooks/`);
    pass-through CRUD service ceremony — either give services real invariants
    or collapse route→repository.

## Docs: the minimal relaunch set

Inventory verdicts (every current page reviewed; no v1 residue found — the
pages are accurate, there are just too many):

| Verdict | Pages |
|---|---|
| **Cut** | all six `walkthrough/` pages (the "Patterns" content: theming, drizzle-schema, organize-backend, instant-updates, ai-chat, overview) — agent-era guidance that agents no longer need and users skip; `blog/welcome.mdx` |
| **Merge** | `walkthrough/users-and-auth` → into the SDK page (its ensureUser pattern is the one load-bearing part — and shrinks further if rec #7 ships) |
| **Rewrite** | `prompts.mdx` (trim to the checklists that still earn their place); root `meta.json` (new nav) |
| **Keep** | introduction, quickstart, coding-agents, create-app, local-dev, how-it-works/overview, how-it-works/sdk, learn-more (FAQ) |

Proposed tree (10 pages, down from 17): **Start Here** (introduction,
quickstart) · **Build** (coding-agents, create-app, local-dev) · **How It
Works** (architecture, sdk-and-manifest) · **Reference** (cli — NEW,
manage-your-gateway — NEW) · **Help** (faq).

Two pages must be *written*, not trimmed: a **CLI reference** (every command
and flag on one page — currently scattered across four pages) and **manage
your gateway** (invites, app access, updating, removing an app, moving
domains). Bonus: `llms.txt` is auto-built by concatenating all docs pages, so
every cut directly shrinks what agents ingest.

## Suggested sequencing

1–5 first and roughly in that order (1 and 2 together — the package extraction
is where the shared protocol lands; 3 next while the API surface is one
endpoint; 4 and 5 are CLI-contained). Tier 2 rides behind 1–2 since the SDK
package is being reshaped anyway. Docs can go immediately — nothing depends on
them.
