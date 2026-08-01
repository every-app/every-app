# Every App v2 — Final Architecture Recommendation

**To:** Founder, every app
**From:** Chief Architect
**Date:** 2026-06-10
**Status:** Decision document — the output of the 4-proposal / adversarial-critique / 3-judge exercise

---

## 1. The Decision

**Adopt Proposal A ("One Door" — perimeter-first gateway proxy), hardened with the specific grafts the judges pulled from D, C, and B.** The vote was 2–1 for A over D, but that undersells the consensus: A and D are the same architecture at two levels of specification, and every judge ranked that shape first and second — one public worker, sub-apps as private workers with no internet face, identity injected by the gateway, one MCP endpoint, one `getAppFetcher()` seam between self-hosted and hosted.

Three-sentence why: it is the only architecture family that makes a vibe-coded unguarded route **structurally unreachable** (R5) while keeping self-hosting at $5/mo (R6) and keeping hosted/self-hosted on one codebase (R2). It deletes the entire failure surface that killed v1 — SessionManager, postMessage, 1-minute tokens, replay windows, org env vars — rather than rearranging it, and reduces an app author's auth surface to one wrapper and one `c.var.user` read. Its adversarial critique was the only one that concluded "none are fatal; all are closable with perimeter-side enforcement," and every closure it needs already exists, named, in the losing proposals.

---

## 2. The Recommended Architecture, End to End

### 2.1 Topology

- **One custom domain per installation** (~$10/yr, hard prerequisite — see Open Question 1). Gateway owns `home.example.com` (login, launcher, settings, agent chat) and the wildcard `*.example.com` (one subdomain per app). **The path-mode/workers.dev quickstart is cut** — every critique that touched it (PSL cookies, false PWA scope, C's control-plane-XSS CRITICAL) said the same thing: it's a second architecture in a trench coat.
- **Admin/control plane on its own origin** (`admin.example.com`): registry, deploy API, OAuth consent, secrets UI. App XSS can never be same-origin with the deployer or secret store (graft from C's worst finding, applied preemptively).
- **Exactly one internet-reachable worker: the gateway.** Sub-apps:
  - **Basic tier ($5/mo):** private workers — no routes, `workers_dev:false`, `preview_urls:false` — invoked via gateway service bindings.
  - **Platform tier / hosted ($25/mo WfP):** one dispatch namespace, scripts `t_<tenant>_<app>` (tagged), invoked via `dispatcher.get(name, {}, {limits, outbound})`. Private by construction.
- The split lives behind **one function**, `getAppFetcher(env, app)`. Everything above it — auth, perimeter policy, MCP, agent, registry — is shared code. Honest framing per the ops judges: shared runtime, forked deploy plane (2.5 pipelines); we accept that and document it as ours, not the author's.

### 2.2 Request flow and auth mechanism

```
Browser → gateway (resolve app from Host; strip Cookie + inbound x-everyapp-*;
authenticate Better Auth session; check org membership + app installed;
mint identity JWT; return appFetcher(app).fetch(req) — streamed)
```

- **One login:** Better Auth, unchanged. Session cookie `Domain=.example.com; HttpOnly; Secure; SameSite=Lax`. Every subdomain terminates at the gateway, which strips the cookie before proxying — **no app ever sees a credential**, and the browser never holds a token.
- **Identity injection:** per request the gateway mints a **120s RS256 JWT** (we keep RS256 — reuse the existing keys; the ES256 line in Proposal A was an error) with `iss, sub, email, org_id, org_role, aud=<app>, chan=web|mcp|agent, act, jti`. Injected as `x-everyapp-identity`.
- **Verification is mandatory, fail-closed** (graft from B's fail-closed argument and the fix that resolved D's CRITICAL): `everyApp()` MUST verify the JWT — alg and kid pinned, `none` rejected, `aud` checked — before populating `c.var.user`. Plain headers are never a trust source. This closes re-exposed workers, sibling-worker service bindings, and SSRF in one stroke.
- **Key delivery** (graft from C, fixes A's JWKS-vs-egress self-contradiction): the gateway's public **key set** (current + next) is injected as an env var at every upload; rotation = pre-publish next key, swap, bulk re-push (automated, since the gateway is the deployer in platform/hosted tier). No runtime JWKS fetch from app workers.
- **CSRF at the perimeter:** private non-GET requests require `Sec-Fetch-Site`/`Origin` consistent with the target app's own subdomain; **default-deny when absent**. On a manifest-declared public route, failure instead forces anonymous mode with only the signed public marker, allowing programmatic webhooks without exposing member identity. No cross-subdomain CORS, ever.
- **Uniform security headers** stamped on every HTML response: HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`, a CSP floor apps can tighten but not remove.
- **App author surface (the whole thing):** `export default everyApp(app, { tools })` server-side; client-side **zero lines** — same-origin `fetch()` rides the cookie. Mobile: each app is an installable PWA with its own scope.
- **Mobile collapses to nothing:** because auth is just a cookie on `.example.com` and apps render as normal pages behind the gateway, the optional Expo shell is a plain WebView pointed at `home.example.com` — the user logs in *inside* the WebView and the engine's cookie jar does the rest. **All RN-specific machinery is deleted:** SessionManager environment detection, the weak-origin allowances (`"react-native"/"null"/""`), the postMessage bridge, and the `expo-origin-normalizer` workaround. One caveat to design around: Google blocks OAuth inside embedded WebViews — fine today (email/password), but if social login is ever added, the login step must open in the system browser (`ASWebAuthenticationSession` / Custom Tabs) and hand the session back.

### 2.3 Perimeter and public endpoints (R4/R5)

- Default-private: unauthenticated traffic never invokes app code.
- `everyapp.config.ts` declares public routes: `public: [{ path, methods }]`. Gateway behavior: allow anonymous access, strip gateway credentials and trust headers, and set a signed `x-everyapp-public` marker.
- Hardening (grafted from the critiques, all tiers): **canonicalize/normalize paths before glob matching, deny on ambiguity**; `/__everyapp/*` never public, enforced post-normalization; `path: "/*"` is a **hard error**, not a warning; admin UI shows the installation's entire public surface on one screen. Hosted abuse controls remain future work and must be added deliberately before metered handlers.
- Egress: platform/hosted tier gets the outbound worker (default-deny outside the manifest `egress` list) **plus the LLM gateway grafted from C** — provider keys injected at the perimeter with per-app/per-user spend caps and token metering; apps never hold AI keys. Basic tier has no egress control; that is stated plainly and is the honest upsell to $25.

### 2.4 MCP aggregation and the agent (R3)

- **One endpoint:** `home.example.com/mcp` via `cloudflare/workers-oauth-provider` (PKCE, DCR — Claude connects with zero setup; KV-hashed tokens). We implement only `/authorize` against the existing Better Auth session.
- **Grafted OAuth hygiene from B:** per-app/per-tool scopes selected explicitly on the consent screen (no blanket `mcp:tools`); exact-string `redirect_uri`; DCR-registered clients can never be auto-consent/first-party; `/oauth/register` rate-limited; **live org-membership + app-installed checks at every internal-token mint**, grants revoked on uninstall/removal.
- **Tools:** declared in the SDK, auto-mounted at `POST /__everyapp/tools/{list,call}` — unreachable except via the fetcher, and requiring a valid identity JWT. Namespaced `todo__create_task`. Catalog snapshotted at deploy, cached in gateway D1.
- **No token passthrough:** the MCP token terminates at the gateway; each `tools/call` mints a fresh internal JWT (`chan=mcp, act={sub:"mcp:<client_id>"}`).
- **The agent is just another MCP-shaped client** of the same ToolBus: same registry, same minting (`chan=agent`), same audit log (actor, tool, app, org in D1).
- **The marquee fix (A's worst finding, H2):** tool risk classification — read / write / destructive — lives in the **operator-controlled registry**, declared in the manifest but enforced at the gateway; the app-supplied `readOnlyHint` is never load-bearing. Write tools require inline user confirmation by default for both agent and MCP channels; tool descriptions and outputs are treated as untrusted content in the agent loop, with per-app tool enablement explicit.

### 2.5 CLI, IaC, and deploys

- **Alchemy is deferred. Wrangler stays — as an internal compile target** (graft from D, the only graft all three judges independently made). `everyapp.config.ts` is the single source of truth; the CLI compiles it to an ephemeral wrangler config at deploy. No generated `wrangler.jsonc` in app repos, no beta IaC dependency near a full-account CF token. Revisit Alchemy when v2 ships dispatch-namespace support — the manifest→deploy seam makes that swap invisible to authors.
- **Why Alchemy doesn't pay for itself yet (evaluated 2026-06-10):** the user-facing simplification it promises (TS config, no wrangler.jsonc, auto-created resources, inferred types) is already delivered by the manifest. Internally it would replace ~400–700 lines of imperative CF API code (`setupCloudflareResources`, ID write-back, migration plumbing) out of a ~5,000-line CLI — but at the cost of: (a) **no dispatch-namespace support in v2**, forcing basic tier onto Alchemy while hosted stays on the WfP REST API — a worse deploy-plane fork than compiling one manifest two ways; (b) a **state store per installation** (local files or an extra DO-backed worker in the user's account) where wrangler is stateless and the registry already is our state; (c) a **~1-release/day beta** with a v1-incompatible state format sitting behind a full-account CF token; (d) Effect peer deps in the toolchain. **Steal its two best ideas now instead:** auto-apply pending D1 migrations on every `everyapp deploy`, and eliminate resource-ID write-back by making the registry the source of truth. Future option once v2 stabilizes: Alchemy's custom state-store layer could point at gateway D1, unifying infra state and registration.
- **CLI auth:** `everyapp login` device-code flow against the gateway → scoped, hashed, expiring deploy token (`eak_…`, scopes `apps:register`, `apps:deploy`). `/api/internal/*` and raw-CF-token auth are deleted. Self-hosted basic: the user's CF token stays on their machine, scoped to Workers/D1/KV edit only. Hosted: developers never hold a CF token; bundle + manifest upload to the platform deploy service.
- **Binding management (basic tier):** the registry is the source of truth; **every gateway deploy reconstructs its service bindings from the registry**, with optimistic concurrency on the settings patch. This kills both the clobber-on-upgrade and racing-deploy failure modes the critiques found. `everyapp doctor` (graft from D) reconciles registry vs bindings vs CF state and probes every registered app for accidental public exposure.
- **Local dev (graft from C — A's biggest hole):** `everyapp dev` runs a gateway-lite + the app under miniflare multi-worker with the **real perimeter, real identity header, seeded dev user, and the real public-route policy engine**, version-pinned to the deployed gateway. Dev-identity machinery is compile-time excluded from prod bundles. $0 until first deploy.
- **Portless compatibility (worktree-parallel dev):** [portless](https://github.com/vercel-labs/portless) gives named `*.localhost` URLs and auto-prefixes the branch name per git worktree (`todo.fix-ui.everyapp.localhost`). It composes cleanly because the dev gateway routes by Host — two requirements baked in: the CLI honors the `PORT` env var when starting miniflare, and the dev gateway parses Host dynamically (first label = app, remainder = base host) instead of hardcoding `localhost:8787`. Each worktree gets its own `.wrangler` state and its own cookie scope, so multiple full gateway+app instances run side by side with zero port juggling; portless's local HTTPS also lets `Secure` cookies and the real CSRF rules run locally.

### 2.6 Hosted platform path

Same gateway, `tenants` table with N rows. One dispatch namespace, untrusted mode, per-tenant D1/KV attached in upload metadata, per-dispatch CPU/subrequest limits, outbound worker + LLM gateway. **Internal JWTs are tenant-scoped in hosted mode** (`aud = t_<tenant>_<app>`). Hostnames: **single-label** `{app}-{tenant}.everyapp.host` under one wildcard cert (fixing A's second-level-wildcard TLS error); BYO domains via CF for SaaS, hostname→tenant in KV. Tenant secrets envelope-encrypted with per-tenant KEKs; signing key and platform CF token isolated from the app-secrets store. Metering via per-script GraphQL analytics + tags; Logpush for audit. Marginal tenant cost well under $1/mo.

---

## 3. The Four Candidates — Judges' Consensus

| | A — Perimeter proxy | B — OAuth/OIDC standards | C — WfP everywhere | D — Pragmatic subdomain |
|---|---|---|---|---|
| Security | 7.0 | 5.7 | 5.0 | 6.3 |
| DX | 6.8 | 5.7 | 7.0 | 8.0 |
| Ops | 7.8 | 6.2 | 6.8 | 8.0 |
| Requirements fit | 8.5 | 6.8 | 5.7 | 8.2 |
| **Overall** | **7.8** | 5.8 | 5.8 | 7.7 |
| Votes | **2** | 0 | 0 | 1 |
| Fatal flaw, in a phrase | None fatal — but no local-dev story, and agent trust inverted onto app-supplied `readOnlyHint` (both fixed by grafts above) | A hand-rolled 1.5–3k-LOC OAuth server sold as "300 LOC," and a secret model that makes localhost dev structurally impossible | $25–30 floor on the priority-#1 path, and a default config where one app XSS owns the deploy API and secret store | Trust model undefined at the exact load-bearing point: "headers alone are trustworthy" |

A and D were the real contest. A wins because it specifies what D leaves implicit — and under-specification at the trust boundary is exactly what becomes a breach. D's best ideas (defer Alchemy, `doctor`, scoped deploy tokens, registry-side tool policy) are all grafted in; nothing of value in D is lost.

---

## 4. Honest Trade-offs

**What we give up.**
- **B's per-app cookie isolation.** The parent-domain cookie is the weakest isolation model of the four; we chose it because B's price (a hand-rolled OAuth AS, impossible local dev, reintroduced CSRF) is "died of complexity" v2.
- **Apps cannot run standalone.** An app is meaningless without its gateway. By design — but it means graduating an app to a genuinely public product means leaving the platform.
- **The "byte-identical" claim is really "shared runtime, forked deploy plane."** Basic, platform, and hosted are 2.5 deploy pipelines we maintain forever (or until Open Question 4 resolves it).
- **Gateway as SPOF.** A bad gateway deploy bricks every app. Mitigation: the proxy core is small and slow-changing, gradual deploys + instant rollback. It already was the de-facto SPOF.

**The $5 vs $25 answer.** Self-hosting stays **$5/mo + ~$10/yr domain** in basic tier — R6 met exactly (proxying does not double-bill; one billed request per chain). The $25 platform tier is an opt-in upgrade that buys the three things basic tier honestly lacks: egress control, per-app CPU limits, and no binding-patch step. We reject C's position ($25 floor) and B's temptation to make WfP the only documented path. The docs say plainly: basic tier has no egress firewall; if you install apps you don't trust, pay the $20.

**Critiques that remain only partially mitigated (eyes open):**
1. **Agent prompt-injection confused deputy.** Registry-enforced tool risk classes, write-confirmations, per-app enablement, and untrusted-output handling *narrow* this; no design solves it. A poisoned read-only tool output can still try to steer the agent. This is the industry-wide unsolved problem; our posture is containment + audit, not elimination.
2. **Cross-app GET-with-side-effects under XSS.** The shared cookie means an XSS'd app can fire authenticated GETs at sibling apps. Perimeter Origin checks cover non-GET; GET mutations in vibe-coded apps are damped by CSP, SDK lint, and `aud`-binding, not eliminated. Accepted at consumer scale.
3. **DO-originated fetches bypass the outbound worker** (Cloudflare platform gap), and **public endpoints are inherently abusable** — future hosted abuse controls can bound the damage, but they won't make a dumb public handler smart. Both are stated in docs rather than pretended away.

Also accepted: ≤120s staleness on revocation within the token window, and the hosted platform CF token as a concentrated credential (isolated deploy service, least privilege).

---

## 5. v2.0 Minimal Scope — Cutting Complexity Without Cutting Security

The full design above is the destination, not the first release. The
**irreducible security core is only four things**, and none of them are
author-facing complexity:

1. One public worker; apps are private (bindings/dispatch).
2. Cookie terminates at the gateway; a short signed JWT is injected; the SDK verifies it (mandatory, ~30 lines inside `everyApp()`).
3. Public routes are explicit in the manifest.
4. MCP tokens terminate at the gateway.

Everything else is hardening or scale and can be deferred from v2.0 without weakening that core:

| Deferred from v2.0 | Why it's safe to defer |
|---|---|
| **The entire hosted/WfP tier** (dispatch namespace, outbound worker, LLM gateway, tenants table, envelope encryption) | Biggest single win — collapses 2.5 deploy planes to 1 and deletes gateway-as-deployer. The `getAppFetcher()` seam makes adding it later purely additive. |
| **The `admin.` origin split** | It guarded against Proposal C's *path-mode* flaw, which this design doesn't have — apps live on their own subdomains, so app XSS is never same-origin with the control plane. The shared cookie reaching `home.*` is already covered by default-deny Origin checks on non-GET. |
| **Granular tool policy** (`tool_grants` table) | v2.0 rule: reads allowed, *every* write requires inline confirmation, policy = org member + app installed. One sentence, no table. |
| **`app_public_routes` table** | Match against the manifest JSON column in code; add the table only if lookup cost ever matters. |
| **Expo wrapper** | PWA-only at launch; the optional WebView shell (§2.2) can come back anytime since it carries zero custom auth logic. |
| **`everyapp doctor`** | Detection tooling, not prevention. |
| **MCP + agent** | Purely additive on top of the `/__everyapp/tools/*` convention — app auth never depends on it. |

What we refuse to cut: **the identity JWT.** "Apps are only reachable via
service binding, so trust the headers" fails open the instant any app is
accidentally re-exposed (a re-enabled workers.dev toggle, a leaked preview
URL) — and it isn't author-facing complexity anyway.

Resulting v2.0: gateway proxy core (~1–1.5k lines), the `everyApp()` SDK
wrapper, manifest → deploy → register, `everyapp dev`, and a modified `apps`
table. Less total machinery than today's SessionManager + postMessage + JWKS +
org-binding stack.

---

## 6. Migration Plan

Each phase independently shippable; old and new auth coexist until Phase 4.

**Phase 0 — Week-one spikes (de-risk before committing).** Verify the three load-bearing unverified claims: static assets in dispatch-namespace uploads, WebSocket 101 through `dispatcher.get` + outbound chain, and miniflare `dispatch_namespaces` local dev. Any failure changes Phase 6/2 design, not the architecture.

**Phase 1 — Gateway proxy core.** Wildcard custom domain, Host→app registry (D1), cookie auth, header strip/inject, RS256 identity-JWT minting (existing keys), CSRF default-deny, uniform security headers, public-route matcher with normalize-before-match and hard-error `/*`. Admin origin split. Ships behind `*.example.com` while iframes keep working at old URLs.

**Phase 2 — SDK v2 + local dev.** `everyApp()` with **mandatory** pinned-alg verification; `defineApp`/`defineTools`; env-var key set; `everyapp dev` gateway-lite (version-pinned, prod-excluded).

**Phase 3 — Migrate apps.** todo-app first (it owns `UserSyncDO` — this is where WS/DO through the proxy gets validated, not workout-tracker), then chef, workout-tracker: private-worker flags, manifest, behind the proxy. Launcher flips from iframe embeds to plain links; PWA per app.

**Phase 4 — DELETE (the payoff).** `SessionManager` + the entire postMessage protocol + iframe/RN/standalone detection; iframe embed routes/components; `/api/session-token`; the 30s replay window and 50s refresh loop; `authenticatedFetch` token plumbing; `EVERY_APP_ORG_ID` checks in every app; mobile-native weak-origin allowances (`"react-native"/"null"/""`); per-app public hostnames. Keep this window short — dual-accept doubles surface while it's open.

**Phase 5 — CLI v2.** Device-flow login + `eak_` scoped deploy tokens; manifest→ephemeral-wrangler compile; registry-driven binding reconstruction on gateway deploys; `everyapp doctor`. **DELETE:** `/api/internal/*`, raw-CF-token auth (ADR-0002 superseded), `wrangler.jsonc` generation in templates.

**Phase 6 — MCP + agent.** workers-oauth-provider with per-app/per-tool scopes; ToolBus with registry-enforced risk policy; `/__everyapp/tools/*`; agent chat in the home shell; audit log.

**Phase 7 — Platform tier + hosted.** Dispatch namespace + outbound worker + LLM gateway behind `getAppFetcher`; single-label hostname scheme; hosted deploy service with envelope-encrypted secrets; metering and billing.

---

## 7. Open Questions for You

1. **Custom domain as a hard prerequisite for self-hosting?** I recommend yes (it kills path mode and its CRITICAL-class risks), but it adds buy-a-domain friction to first-run. Sign off or we need a designed degraded mode.
2. **Agent write-tool confirmations:** require inline user confirmation for *all* write tools (safe, naggy) or only registry-flagged destructive ones (smooth, riskier)? This is a product-feel call.
3. **Basic tier's lifespan:** permanent commitment, or a bridge we sunset once the hosted free/cheap tier exists? It's the flakiest subsystem (binding patches) and half of the deploy-plane fork.
4. **Hosted brand + scheme:** confirm `{app}-{tenant}.everyapp.host` single-label naming and the hosted domain itself — it's baked into certs, KV maps, and marketing.
5. ~~**Mobile:** keep the Expo WebView wrapper or go PWA-only?~~ **Resolved (2026-06-10):** all custom mobile auth logic is deleted regardless — the cookie model means an Expo shell is just a WebView loading `home.example.com` (§2.2). v2.0 ships PWA-only; resurrect the dumb-WebView shell later only if app-store presence or push notifications justify the packaging work. `gateway/mobile-native` as it exists today is deleted either way.
   **Revised (2026-07-15):** the shell is back as `apps/mobile-native`, with native chrome (sign-in, app list) rather than the dumb-WebView variant — but still zero client token logic. Native login uses the Better Auth Expo client (server re-trusts only `everyapp://`; no `exp://` dev origins), the app list comes from the REST route `GET /api/me/apps`, and the session cookie is copied into the WebView cookie store scoped to the gateway host so embedded apps authenticate exactly like a browser tab. `/api/session-token`, the postMessage bridge, and `SessionManager` stay deleted.

---

*The thesis, one last time: every alternative ends with vibe-coded workers reachable from the internet and an auth dance in the client. This one makes the insecure thing unreachable and the auth dance nonexistent — one door, one cookie, one injected header, one MCP endpoint, one seam. The deletions are the feature.*
