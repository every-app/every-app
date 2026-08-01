# Gateway Auth for App MCP/HTTP APIs — Decision Comparison

**First, a framing correction that matters for the whole decision:** these are **three** architectures, not four. **B (PAT `epat_`)** and **C (session-token `eak_`)** are the same design — a gateway-*terminated* static bearer that mints the existing internal identity JWT — differing only in table naming and framing. I score them separately below to show it, but treat them as one lane: **"gateway-terminated static bearer."** The real fork is: **A** = full OAuth AS (terminated), **B/C** = static bearer (terminated), **D** = forwarded bearer, verified *locally in the app*.

## 1. Scoring matrix

Scale: Strong / Good / Fair / Weak / Poor.

| Criterion | A — OAuth AS | B — PAT (`epat_`) | C — session-token (`eak_`) | D — decentralized (forward + local verify) |
|---|---|---|---|---|
| **claude.ai connectors** | **Strong** — only real path; full RFC9728→PKCE flow, no static-bearer field needed | **Poor** — connector UI has no static-bearer field; unsupported | **Poor** — same gap | **Strong** *only via its Tier B*, which is A rebuilt |
| **Claude Code** | Strong — OAuth/CIMD loopback | Strong — `--header` | Strong — `--header` | Strong — header or OAuth |
| **Cursor** | Strong — OAuth login | Strong — headers map | Strong — headers map | Strong — headers/OAuth |
| **Generic API client / CI** | **Fair** — must run OAuth dance or pre-reg client+refresh; ergonomic tax | **Strong** — plain bearer, dominant path | **Strong** — plain bearer | **Strong** — plain bearer |
| **Security posture** | **Strong** — terminated, audience-bound, consent, live re-check; +new CIMD-SSRF surface | Good — terminated + mints JWT + live re-check; long-lived plaintext bearer = top leak risk | Good — same terminated model; "session-derived" oversold | **Fair/Weak** — token reaches app; enforcement can *silently fail open*; revocation TTL-bounded |
| **Gateway complexity/effort** | **Weak (L)** — new AS subsystem, consent+revocation UI, KV store, 3rd-party dep | **Strong (S–M, ~700)** — reuses `app_tokens` infra, 1 table + 1 branch | Good (M, ~700) — new module, 1 table | Weak (L) — Tier A alone ~1.8–2.6k LOC (SDK toolkit, fail-closed guard, CLI lint, revocation distribution) + Tier B |
| **Fit with perimeter invariants** | **Strong** — routes stay private, fail-closed & header-strip intact | **Strong** — private routes, terminated, strip strengthened | **Strong** — same | **Weak** — default-private enforcement *moves into the app SDK*; the design's own biggest hole |
| **Multi-tenancy (100k untrusted apps)** | Good — org-partitioned grants; gateway-global client store accumulates → needs TTL/CIMD | **Strong** — per-org rows, perimeter-only state; add cache at scale | **Strong** — same | **Fair** — best hot-path CPU story, but the fail-open risk is *per untrusted app* and silent → undercuts the win |
| **User & app-author UX** | Good (one-click connect) / Fair (scripts) | Good — paste one header; manual token mgmt | Good — same | **Fair** — author must wire SDK guard correctly or leak |
| **Standards compliance** | **Strong** — the point | Poor — not spec | Poor — not spec | Strong (Tier B) |
| **Reversibility** | Fair — live public AS protocol contract with external clients | **Strong** — gateway-internal, no app/protocol contract | **Strong** — explicit bridge; JWT reused when OAuth lands | **Weak** — contract lives in app authors + manifest; reversing touches every app |

## 2. Tradeoff axes

- **Gateway terminates credential ⟷ app verifies locally.** *The* axis. A/B/C put the enforcement point at the gateway (app only ever sees a minted, fail-closed identity JWT). D forwards the raw bearer and trusts an in-app SDK guard. The v2 thesis — "the gateway handles auth," fail-closed, ~100k *untrusted* apps — pulls hard toward **terminate**. D sits alone on the wrong side.
- **Works-today for CLI clients ⟷ standards-complete for connectors.** B/C = works today, zero connectors. A = connectors + standards, heavy. D straddles (Tier A today, Tier B = A).
- **Static long-lived bearer ⟷ short-lived consented grant.** B/C static (leak-prone, manual rotation). A short-lived + user consent + live re-check. Security vs. ergonomics; the live `hasAppAccess` re-check narrows the gap for B/C.
- **Reversible internal mechanism ⟷ external/author-facing contract.** B/C are private gateway plumbing you can rip out. A is a public AS protocol contract. D pushes the contract into every app author.

The clarifying observation: **A, B, and C all mint the *same* internal identity JWT** via the existing path and all keep `/mcp`+`/api/*` private. They are layers of one stack, not rivals. D is the only genuinely different security model.

## 3. Recommended path — phased, terminate-at-gateway

**Phase 1 (now, P0): ship the gateway-terminated static bearer — the union of B and C.**
Take C's `eak_` bridge framing and reuse-of-mint-path, plus B's discipline (separate `user_access_tokens` table with *user* principal semantics, reuse of `app-token-hash`/`AppTokenRepository`/`/admin/tokens` UI). Concretely: reserved `eak_`/`epat_` prefix; authenticator branch *before* the cookie path; validate → synthesize `AuthenticatedSession` → **live `hasAppAccess` re-check every request** → `mintIdentityJwt` with `chan="mcp"`, `act={sub:"token:<id>"}`; bearer requests are CSRF-exempt; the reserved-prefix `Authorization` is consumed and **stripped on all routes**. Routes stay **private**. ~700 LOC, near-zero app/SDK change, fully reversible. This unblocks Claude Code, Cursor, and every generic API/CI client **the same day** with no invariant regression. Highest ROI on the board.
*Fix C's one real weakness:* set `chan` from the credential, not by sniffing the route path.

**Phase 2 (committed fast-follow, P1): OAuth AS (A), scoped to a single `app:use` scope.**
Mount `workers-oauth-provider` so `/mcp`+`/api/*` validate the OAuth bearer and mint the **same** internal identity JWT, with the OAuth grant **writing into the Phase-1 credential store** (C's "token store becomes the backend the OAuth grant writes into"). This adds **claude.ai connectors — the only client that forces OAuth** (no static-bearer field, issue #112). Defer ToolBus/per-tool scopes to Phase 6. Budget the real cost in consent + revocation UX and **CIMD-SSRF hardening**, not the protocol plumbing.

**Reject D as the default/primary model.** For ~100k *untrusted* apps, "author forgets or mis-wires the SDK guard → silently open endpoint" is a per-app, fail-*open* failure — the exact inversion of the perimeter thesis, and dangerous for *buggy-honest* apps, not just malicious ones (a malicious app only ever sees its own tokens). Its multi-tenancy hot-path win is bought with precisely this regression. **Borrow one idea from D and nothing else:** to answer its legitimate scaling point for the dispatch future, add a short-TTL (10–30 s) token-validation cache at the gateway, matching the existing 30 s org/registry caches — this recovers most of the CPU win while staying terminated and fail-closed. Local verification is not needed to scale.

**Composition with Wave 2 primitives:**
- **`getAppFetcher` / `APP__` binding:** both phases sit strictly *above* the proxy seam; unchanged. The `tier:"dispatch"` future inherits the already-audience-bound (`aud=appId` → `t_<tenant>_<app>`) token model for free.
- **Provider allowlist (legacy AI proxy):** keep orthogonal, and enforce the hard rule from B/C §10 — **the terminated ingress bearer must never carry a provider/egress scope**, or it decays into the ambient app-token Wave 2 deliberately retired.
- **#220 public-route `Authorization` forwarding:** clean **reserved-prefix split**. `eak_`/OAuth bearers → gateway-consumed and stripped on *all* routes; any non-Every-App `Authorization` keeps #220's verbatim passthrough for apps running their own bearer auth on public routes. Because Phase-1/2 keep `/mcp`+`/api/*` **private**, #220 doesn't even apply there — the strip is belt-and-suspenders. No conflict; one credential space, two disjoint namespaces.

## 4. Decisions Ben must make

1. **Is claude.ai connector support required for v2 GA, or an acceptable fast-follow?** (Sets the OAuth AS as P0 vs P1 — everything else holds either way.)
2. **Do we hold the invariant "the gateway, never the app, is the component that can fail open"?** Yes → D is rejected as default; No → D's hot-path scaling reopens for debate.
3. **Is the static bearer a permanent product surface, or a bridge we deprecate once OAuth+connectors ship?** (Governs how much to invest in PAT-management UX, secret-scanning, `last_used_at` monitoring.)
4. **One credential store that OAuth grants and static tokens both write into, or two?** (Governs whether Phase 2 reuses Phase 1's table — recommend one.)
5. **Build the AS on `workers-oauth-provider`, or hand-roll it?** (A third-party dependency on the auth perimeter, on an evolving lib whose token-store format becomes a persistence contract.)
6. **Single `app:use` scope now, or invest in per-tool/ToolBus risk-classified scopes (Phase 6) up front?**

## 5. What the docs got wrong / missed / mis-sold

- **B ≈ C.** They're one architecture; the exploration reads as four options when it's three. Present them merged.
- **C's "session-derived" is a misnomer.** The tokens have an *independent* lifecycle — revoking the browser session does **not** revoke them (C admits this in §6/§9). It's a PAT with a different prefix; B is the more honest framing. The real revocation backstop in both is the per-request `hasAppAccess` re-check, which all of A/B/C get and which deserves to be foregrounded — it bounds revocation lag by *entitlement*, not just token TTL.
- **D undersells its own fatal flaw for untrusted apps.** "App forgets the SDK guard → open endpoint" is silent, per-app, and hits buggy-honest apps. Its §6 calls it "the single biggest weakness"; for 100k untrusted apps that's disqualifying as a default, and the multi-tenancy "win" is *bought with* that regression.
- **A oversells "smallest-diff mount."** `workers-oauth-provider` wants to own the entrypoint; the double-dispatch (`apiRoute` prefix matching across *per-app hostnames*, plumbing `ctx.props`, and *not* re-running cookie auth on the API path) is the genuine integration risk, on top of taking a dependency on the auth perimeter. Under-weighted. CIMD-SSRF into the Cloudflare private network is a real *new* attack surface, correctly flagged but easy to under-resource.
- **Effort comparison is apples-to-oranges.** D's Tier A (~1.8–2.6k LOC) vs B/C (~700) for "the same" API-key issuance — the entire delta *is* the cost of moving enforcement into the app (SDK toolkit, fail-closed guard, CLI lint, revocation-list distribution). That delta is itself an argument against D.
- **Auth is necessary but not sufficient — under-stated by all four.** Every "Yes" in the connector matrices assumes the app actually implements a Streamable-HTTP MCP handler. Only A explicitly ships the `createMcpHandler` SDK helper that makes that true; make it a shared Phase-1 deliverable.
- **All four correctly nail the load-bearing fact** — the claude.ai connector UI exposes no static-bearer field (issue #112) — which is exactly why connectors force OAuth and why the phasing (static-bearer first, OAuth for connectors second) is the right shape.