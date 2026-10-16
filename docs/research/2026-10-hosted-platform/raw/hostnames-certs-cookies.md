# Hostnames, certificates and cookie scope for the hosted gateway

Researcher report, 2026-10-15. Worktree `t3/void-cloudflare-every-app-impact`
at `e1d9d3c6`. Scope: where the hosted control plane and the app hosts live,
which certificates cover them, how a signed-in user's session reaches an app
host, how BYO customer domains attach, and what that means for app-host
`/mcp` and the OAuth "own-domain" refusal.

## TL;DR

- **Recommend scheme C for the prototype and for GA.** Control plane at
  `app.everyapp.com` with a host-only session cookie. Apps at
  `{app}-{orgKey}.<content domain>` on a **separate registrable domain**
  (for example `everyapp.app`), all covered by that zone's free Universal SSL
  wildcard and one Worker route. Each app host gets its own `__Host-` cookie,
  minted by the gateway through a silent one-time redirect handoff (the same
  shape as `mobile-sign-in.ts`). Submit the content domain to the Public
  Suffix List at GA. BYO domains are per-app Cloudflare for SaaS custom
  hostnames that use the same handoff. About 3 engineer-days for the
  handoff, about 5 days for the whole hostname/cookie layer before BYO.
- **Scheme A (one parent-domain cookie for all tenants) fails for a reason
  the CSRF analysis misses: cookie tossing.** Any org's app can run its own
  JS on a same-site host and write a cookie for the parent domain.
  Better Auth 1.7.7 keeps the *last* duplicate cookie it parses, so a
  malicious org app can silently sign a victim into the attacker's account
  on the control plane and on every other tenant's app (session fixation).
  It can also cookie-bomb every `*.everyapp.com` host past Cloudflare's
  128 KB header limit. The CSRF default-deny holds for non-GET, but that
  is not the weak point. A is fine only while every app on the shared
  domain is our own code.
- **Scheme B (per-org subdomains, per-org cookie)** needs a wildcard
  certificate per org. Cloudflare for SaaS wildcard custom hostnames are
  Enterprise-only (plans page, 2026-08-14), so on our plans that means
  juggling ACM certificates. B still needs a handoff, because the control
  plane cannot set a cookie for `acme.everyapp.app`. It still needs a PSL
  entry for orgs to be isolated. C is cheaper and gives the same
  guarantees, so B loses to C.

---

## 1. What exists today

### 1.1 Host routing is already scheme-agnostic

- `apps/every-app-gateway/src/server.ts:166-240`: one Worker. A request whose
  Host is the `GATEWAY_URL` host goes to the control plane. Any other host is
  looked up by full hostname in the D1 registry (`resolveAppByHostname`, a
  per-isolate cache with a 30 s TTL for hits and 5 s for misses,
  `server.ts:55-105`). An unregistered host under the gateway host or under
  `APP_BASE_DOMAIN` gets `404 unknown_app_host` (`server.ts:217-228`). The
  hostname-to-app mapping is a plain table lookup, so it works for any
  naming scheme and for BYO hostnames once they are rows.
- The registry row has a unique `hostname` (`packages/perimeter/src/registry.ts:28-40`).
  Adjacent issue for another researcher: `findByAppId`
  (`registry.ts:44-45`) assumes `appId` is globally unique. That stops being
  true in hosted, where every org has its own `todo`.
- Hostname assignment, `hostnameFor`
  (`apps/every-app-gateway/src/server/services/AppRegistrationService.ts:141`):
  - the install's own org gets `<appId>.<base>`;
  - every other org gets `<appId>-<orgKey>.<base>`;
  - the org key is the slug's `[a-z0-9]`, at most 12 characters, with a
    numeric suffix on collision. It never contains a hyphen
    (`AppRegistrationService.ts:120, 215-252`).

  Hosted has no "install org", so every app is `{app}-{orgKey}`. That branch
  already exists.
- `app-hosts.ts:4-15`: `APP_BASE_DOMAIN` "is the gateway's own host for now:
  the mobile shell scopes its copy of the session cookie to the gateway host,
  and apps find their way home by dropping their first label." Two concrete
  couplings follow from that sentence:
  - the catalog apps' `gatewayHomeUrl()` strips the first label
    (`apps/todo-app/src/client/lib/gatewayHome.ts:10-16`, with copies in
    chef and workout-tracker);
  - the sign-in page's `getSafeReturnTo` only allows subdomains of the
    current host (`apps/every-app-gateway/src/utils/auth.ts:36-71`).
- Self-host is moving to per-app Workers Custom Domains only
  (`docs/cli-redesign.md:660-662` deletes wildcard routing). Custom Domains
  are capped at **100 per zone** (Workers limits). Each one gets its own
  Advanced Certificate, including multi-level names like
  `todo.apps.company.com`, with no ACM subscription (Custom Domains docs).
  Hosted cannot use Custom Domains for apps: the 100 cap, and Workers for
  Platforms user Workers are reached through the dispatcher, not their own
  routes. The hosted gateway therefore needs a wildcard **route**, which is
  exactly the mode self-host is deleting. That is fine, because the hosted
  gateway is deployed by its own pipeline, but it should be stated.

### 1.2 The session cookie spans the gateway host and its subdomains

- `apps/every-app-gateway/src/auth/config.ts:190-221` (`resolveCookieDomain`)
  returns `APP_BASE_DOMAIN`, or else the gateway hostname. `config.ts:280-287`
  turns on Better Auth `crossSubDomainCookies` with that domain.
- Better Auth 1.7.7 then names the cookie `__Secure-better-auth.session_token`
  with a `Domain` attribute
  (`node_modules/better-auth/dist/cookies/index.mjs:28-38`). A cookie with a
  Domain attribute cannot use the `__Host-` prefix.
- Better Auth's cookie parser keeps the **last** value for a duplicated name:
  `parseCookies` does `cookieMap.set(key, …)` in a loop
  (`node_modules/better-auth/dist/cookies/cookie-utils.mjs:157-168`). §3.1
  shows why this matters.
- `cookieCache` is disabled (`src/auth/shared.ts:8-12`), so every perimeter
  request reads the session from D1. That is good for revocation, and it
  means a per-app-host session check in scheme C costs no more reads than
  today.
- The perimeter strips `Cookie`, `Authorization`, `x-everyapp-*` and
  `cf-access-*` before proxying (`packages/perimeter/src/headers.ts:44-59`).
  It removes `Domain=` from app `Set-Cookie` headers (`headers.ts:179-187`);
  the control plane opts out of that (`headers.ts:204-209`).
- The mobile shell copies Better Auth's cookies into the WebView jar with
  `Domain=<gateway host>` so that embedded app hosts receive them
  (`apps/mobile-native/src/lib/webview-cookies.ts:61-78`).

### 1.3 Org binding uses the session's active org

- `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:116-130`
  resolves the org from `session.activeOrganizationId`. It falls back only
  when the user belongs to exactly one org (`orgContext.ts:84-98`).
- `hasAppAccess` then requires `session.orgId === app.organizationId`
  (`betterAuthAuthenticator.ts:133-136`).

With one cookie shared across orgs, a user in two orgs can open only the
apps of their *active* org. Every other org's app answers
`403 no_app_access` until they switch. A multi-org hosted product cannot
keep this as is.

### 1.4 CSRF holds against sibling hosts for everything except GET

- Non-GET requests need `Sec-Fetch-Site: same-origin`, or, without that
  header, an `Origin` equal to the app host (`packages/perimeter/src/csrf.ts:31-65`).
  So a sibling app's page (`same-site`) is refused.
- WebSocket upgrades need an Origin equal to the app host (`csrf.ts:79-99`).
- Server functions accept only same-origin `fetch()` calls.
- A GET to an app host's `/mcp` never makes the gateway call the app
  (`src/server/toolbus/app-host-mcp.ts:68-75`; `docs/security-model.md:165-174`).
- **CORS gap.** The perimeter passes an app's `Access-Control-Allow-*`
  response headers through untouched. `withSecurityHeaders` copies every
  header (`headers.ts:219-255`), and nothing in `packages/perimeter/src`
  touches `access-control-*`. An app that reflects `Origin` and sends
  `Access-Control-Allow-Credentials: true` lets any same-site page read its
  authenticated responses.
- Arch-v2 accepted the remaining risk: "an XSS'd app can fire authenticated
  GETs at sibling apps … Accepted at consumer scale"
  (`docs/architecture-v2-recommendation.md:105`).
- **Correction to `docs/security-model.md:284-285`.** It says stripping
  `Domain` means "apps cannot set parent-domain cookies". That is true only
  for `Set-Cookie` headers that pass through the proxy. Page JavaScript can
  still write `document.cookie = "…; Domain=<parent>"` from any app host,
  because RFC 6265 lets a host set cookies for its parent domain unless the
  parent is a public suffix.

### 1.5 The login redirect

- `packages/perimeter/src/gateway.ts:361-371` sends a 302 to
  `${GATEWAY_URL}/sign-in?return_to=<app URL>` (`loginUrl`, `server.ts:250`).
- `getSafeReturnTo` accepts only `*.<current host>` (`src/utils/auth.ts:36-71`).

### 1.6 OAuth and `/mcp` on app hosts

- App hosts are not OAuth resources:
  - the RFC 9728 metadata paths return 404 (`gateway.ts:209-218`);
  - the `WWW-Authenticate` challenge sends clients to the gateway's own
    `/mcp` (`gateway.ts:114-118`);
  - tokens issued by the gateway's OAuth server are refused on app hosts
    (`headers.ts:84-92`, `betterAuthAuthenticator.ts:108-114`).
- Own-domain refusal: `onGatewayDomain` is `host === gateway ||
  host.endsWith("." + gateway)` (`src/server/mcp-auth/own-domain.ts:25-35`).
  It runs at the authorize endpoint (`authorize.ts:96,117`), the consent page
  (`consent.ts:130`) and the token endpoint (`routes.ts:209`).

  The reason it exists (`own-domain.ts:1-13`): under
  `global_fetch_strictly_public`, a fetch for our own zone goes out through
  Cloudflare's front door, which is the gateway. An app's public route could
  therefore serve a Client ID Metadata Document that would pass as a
  verified client.

### 1.7 There is already a working handoff to copy

`src/auth/cloudflare-access/mobile-sign-in.ts:1-30, 141-198` already does
this for the mobile shell. It issues a one-time code with a 2-minute TTL,
bound to a secret and to the browser that started the flow. The code is
stored hashed in Better Auth's verification table (`createVerificationValue`,
`mobile-sign-in.ts:189-193`). Scheme C's app-host handoff is the same
pattern with a different redirect target.

### 1.8 Domains on hand

Read from the Cloudflare API on 2026-10-15:

- `everyapp.com`, `everyapp.dev`, `everyapp.cc` and `everyapp.team` are all
  Free-plan, full-setup zones.
- `openseo.so` is on an **Enterprise** plan.
- There is no `everyapp.host` or `everyapp.app` zone.
- The marketing site is a Workers Custom Domain on the `everyapp.com` apex
  (branch `everyapp-com`: `landing-page/wrangler.jsonc` routes
  `everyapp.com` with `custom_domain: true`).
- `everyapp.dev` and `www` redirect to the apex (commit `e82ac711`).

### 1.9 What arch-v2 §2.6 left unsaid

`docs/architecture-v2-recommendation.md:73` proposes single-label
`{app}-{tenant}.everyapp.host` under one wildcard certificate, BYO domains
through Cloudflare for SaaS, and a hostname-to-tenant map in KV. Two
corrections:

1. It never places the control plane. If the control plane is not on
   `everyapp.host`, a parent-domain cookie **cannot reach the app hosts at
   all**, so §2.6 implicitly requires a handoff (scheme C). If the control
   plane is on `everyapp.host`, it is scheme A, with tenant code on the
   login domain.
2. The hostname-to-tenant map in KV is unnecessary. The D1 registry plus
   the isolate cache already resolve hosts (`server.ts:77-105`). Custom
   metadata for routing would also be Enterprise-only (§2).

---

## 2. Cloudflare and browser facts the design rests on (dated)

| Fact | Source |
|---|---|
| On a full-setup zone, Universal SSL covers only the apex and first-level subdomains. `*.app.example.com` needs ACM (an advanced certificate or Total TLS) or a custom certificate. | Universal SSL limitations, updated 2026-10-09 |
| A wildcard covers exactly one level. To cover `x.app.example.com`, add `*.app.example.com` to an advanced certificate. A certificate holds at most 50 SANs, and the zone apex must be one of them. | ACM docs |
| ACM costs **$10/mo** per zone. Total TLS (one certificate per proxied hostname) requires ACM. | cloudflare.com/plans/network-cdn.md; Total TLS docs, 2026-04-16 |
| `*.*.example.com` is impossible. A "Wildcard Domain Name" is `*.` followed by an FQDN, and `*` may only be the whole left-most label. | CA/B BR v2.3.1 (2026-10-04) definitions; RFC 9525 §6.3 |
| Workers Custom Domains: **100 per zone**. Routes: 1,000 per zone. "If you require more than 100 custom domains per zone, consider using a wildcard route." | Workers limits |
| A Custom Domain gets its own Advanced Certificate, including multi-level hostnames, with no ACM subscription. | Custom Domains docs, 2026-09-29 |
| Cloudflare for SaaS on Free/Pro/Business: 100 hostnames included, **$0.10/mo per additional hostname**, maximum 50,000. **Wildcard custom hostnames: Enterprise only. Custom metadata: Enterprise paid add-on. Apex proxying/BYOIP: Enterprise paid add-on.** Custom origin: all plans. | Cloudflare for SaaS plans, 2026-08-14 |
| A Worker can be the fallback origin: an originless fallback record (`AAAA 100::`) plus a `*/*` route on the SaaS zone. When a route matches, `custom_origin_server` is bypassed; route per host with the `Host` header or `request.cf.hostMetadata`. | "Workers as your fallback origin"; WfP hostname routing, 2026-09-24 |
| Hostname validation is real time (the customer's CNAME points at the target) or pre-validation (a TXT record at `_cf-custom-hostname.<host>`, or an HTTP token). Certificate DCV is automatic over HTTP once the CNAME points at us. **Wildcard certificates require TXT DCV.** | Pre-validation, 2026-04; HTTP DCV and TXT DCV pages, 2026-09-24 |
| "In automatic processes, most validations complete within the first five minutes". Retries back off from 60 s to a 4 h cap. | DCV validation backoff schedule, 2026-06-19 |
| Request headers are capped at **128 KB** in total. | Workers limits; changelog 2025-10-16 |
| PSL private entries need a `_psl` TXT record kept in place, a registration that runs more than 2 years past the PR date, and a rationale. "Projects that are smaller in scale or are temporary or seasonal in nature will likely be declined." Changes "may take time to percolate"; there is "no way to expedite". | PSL wiki, Guidelines |
| CAs check wildcard requests against the PSL's **ICANN section only**, not the private section. A private PSL entry does not block a `*.everyapp.app` certificate. | CA/B BR 3.2.2.6 |
| A cookie's Domain cannot be a public suffix such as `github.io`. `__Host-` requires Secure, no Domain and `Path=/`. `__Secure-` requires only Secure. Browsers that don't support a prefix accept the cookie anyway. | MDN, Set-Cookie |
| `__Http-` and `__Host-Http-` cookies cannot be written by script. Supported in Chrome 140+ and Firefox 143+; **not in Safari, including iOS through 26.5**. | MDN, Document.cookie; caniuse |
| Script cannot overwrite an HttpOnly cookie with the same name, domain and path (§5.3 step 11). The Cookie header lists longer paths first, then older cookies first (§5.4). Browsers keep at least 50 cookies of 4,096 bytes per domain (§6.1). | RFC 6265 |
| A "site" is the registrable domain, meaning a PSL entry plus one label. SameSite and `Sec-Fetch-Site: same-site` both depend on the PSL. | MDN, Site glossary |
| GitHub moved Pages to `github.io` in 2013 because user JS on `*.github.com` could throw cookies to the parent domain, enabling session fixation and CSRF-token fixation. | GitHub blog, 2013-04-05 and 2013-04-09 |
| Chrome's bounce-tracking mitigation spares sites the user interacted with in the last 45 days. Signing in to the identity provider counts, and SSO redirects are not expected to be affected. | Chrome developer blog (2023 dev trial) |

---

## 3. The three schemes

### 3.1 Scheme A: one shared parent-domain cookie for all tenants

**Layouts**

- **A1.** Control plane at `app.everyapp.com`; apps at
  `{app}-{orgKey}.app.everyapp.com`; cookie `Domain=app.everyapp.com`.
  `*.app.everyapp.com` is a second-level wildcard, so it needs ACM
  ($10/mo, one advanced certificate with SANs `everyapp.com`,
  `app.everyapp.com`, `*.app.everyapp.com`).
- **A2.** Control plane at the `everyapp.com` apex; apps at
  `{app}-{orgKey}.everyapp.com`; free Universal SSL; cookie
  `Domain=everyapp.com`. The marketing site and every other subdomain of
  the brand then receive the session cookie.

**Code delta** is close to zero:

- set `GATEWAY_URL=https://app.everyapp.com` and
  `APP_BASE_DOMAIN=app.everyapp.com`;
- add a `*.app.everyapp.com/*` route;
- use the hostname branch without an install org.

**Threat model.** In hosted, any org can deploy an app (a Workers for
Platforms user Worker) whose public routes serve arbitrary HTML and JS to
anyone. Public routes are auth-optional (`gateway.ts:269-287`). Any
signed-in Every App user who opens a link to such a page runs the attacker's
JS in a context that is same-site with every other tenant and with the
control plane. The victim does not need to be a member of the attacker's
org.

**Attack 1: riding authenticated requests (the case the task names).**

- Non-GET, WebSocket, server-function and `/mcp` POST requests are blocked
  by the same-origin rule (§1.4). This part of the CSRF default-deny holds
  across tenants.
- GETs to `y-victimorg.app.everyapp.com` carry the shared cookie. They
  succeed only if the victim has access to that app **and**, with today's
  code, the victim's *active* org is that org (`betterAuthAuthenticator.ts:136`).
  So today the condition is "member of both, and the target org is active".
  - Side-effecting GETs in vibe-coded apps run.
  - The responses are unreadable unless the target app reflects CORS with
    credentials, which the perimeter does not stop (§1.4).
  - Fixing the multi-org UX (authorize against membership in the app's
    org instead of the active org) widens this to "member of both".
- On its own, this is acceptable for a prototype and arguably for GA with
  CORS stripping, as arch-v2 judged.

**Attack 2: cookie tossing leads to session fixation (the actual blocker).**

1. The attacker signs in to their own account and copies their own,
   validly signed `__Secure-better-auth.session_token` value.
2. On `x-evil.app.everyapp.com`, page JS runs
   `document.cookie = "__Secure-better-auth.session_token=<attacker>; Domain=everyapp.com; Path=/; Secure"`.
3. This is a different cookie from the victim's
   (`Domain=app.everyapp.com`), so RFC 6265's rule against overwriting an
   HttpOnly cookie does not apply.
4. The browser now sends both cookies to `app.everyapp.com` and to every
   app host. Their paths are the same length, so the victim's older cookie
   comes first and the attacker's newer one last (RFC 6265 §5.4).
5. Better Auth keeps the last value (`cookie-utils.mjs:157-168`).
6. The victim's control plane and every app now run as the attacker. The
   victim may paste an OpenRouter key or connect GitHub into the
   attacker's org. They may approve an MCP connection into the attacker's
   account. The attacker's apps record whatever the victim types.

Domain notes: under A2 the attacker writes `Domain=everyapp.com` directly.
Under A1, `Domain=everyapp.com` also works because app hosts sit under the
brand domain. The Better Auth cookie value is signed, but the attacker has
a validly signed value: their own. Session fixation by tossing cookies is
exactly the attack that made GitHub move Pages off its main domain in 2013.

Partial mitigations inside A:

- Refuse any request whose raw Cookie header has more than one session
  cookie. This turns fixation into a forced logout.
- Use an `__Http-` prefixed name, so script cannot write it. This does
  nothing on Safari or in the iOS WebView the mobile shell uses.

Neither mitigation helps against attack 3.

I derived this from the code and the RFCs rather than reproducing it in a
browser. It is the first claim to verify (§9).

**Attack 3: cookie bombing.** Script writes at least 50 cookies of 4 KB for
`Domain=everyapp.com`. That is at least 200 KB against Cloudflare's 128 KB
request-header cap. The victim then cannot load the control plane, any app,
or (under A2) the marketing site until they clear their cookies.

**Other costs**

- **Reputation.** Phishing hosted on `*.app.everyapp.com` drags
  `everyapp.com` onto blocklists.
- **No PSL.** Putting the shared-cookie domain on the PSL deletes the
  shared cookie, so A can never be hardened that way.
- **BYO needs C anyway.** `apps.acme.com` cannot receive an
  `everyapp.com` cookie, so BYO requires C's handoff. A with BYO is C plus
  a second mechanism.

**Verdict.** A is acceptable for the prototype **only while every app on
the shared domain is ours** (catalog apps). It is not acceptable once
org-deployed apps or untrusted forks are live with outside users, and not
for GA. The same tossing path exists in self-host today, with lower stakes
(a company's own apps, though an XSS in one of them hands the capability to
an outsider). The duplicate-cookie refusal is worth adding there anyway.

### 3.2 Scheme B: per-org subdomains with a per-org cookie

**Layout.** Control plane at `app.everyapp.com`; org host
`{orgKey}.everyapp.app`; apps at `{app}.{orgKey}.everyapp.app`; cookie
`Domain={orgKey}.everyapp.app`.

**Certificates.** Each org needs `*.{orgKey}.everyapp.app`. The options:

- Universal SSL: does not cover it.
- Cloudflare for SaaS wildcard custom hostnames: **Enterprise only**, and
  TXT DCV is required for wildcards. We control the zone, so the TXT
  records are automatable.
- ACM: pack up to 49 org wildcards per advanced certificate and re-issue as
  orgs come and go. Every re-issue publishes the list of org keys in
  Certificate Transparency logs. The cap on advanced certificates per zone
  is not documented for non-Enterprise plans; Enterprise ACM allows 100.
- Total TLS: one certificate per proxied hostname. It needs ACM, and how it
  treats a wildcard DNS record is undocumented.
- Per-app non-wildcard certificates work on any plan, but each new app then
  waits minutes for its certificate.

**Cookies and sign-in.** The control plane cannot set a cookie for
`acme.everyapp.app`, which is another registrable domain. B therefore needs
either a per-org handoff (C's machinery, run per org instead of per app) or
a sign-in page on each org host.

**Isolation.**

- Orgs are isolated from each other only if `everyapp.app` is on the PSL.
  Without it, org X's JS can toss cookies onto `Domain=everyapp.app`.
- With a non-wildcard PSL entry for `everyapp.app`, `acme.everyapp.app` is
  registrable, `Domain=acme.everyapp.app` is legal, orgs are isolated from
  each other, and apps within an org share one trust domain, as in
  self-host today.

**Code.**

- `hostnameFor` becomes two-level.
- Better Auth's cookie domain is static config
  (`crossSubDomainCookies.domain`, `index.mjs:24-25`), so a per-org cookie
  needs a per-request auth instance or a custom cookie writer.
- If each org host is meant to act as its own gateway, every single-issuer
  assumption has to change:
  - Better Auth's `baseURL` (`config.ts:262-264`);
  - `trustedOrigins` (`config.ts:228-231`);
  - the identity JWT `iss`;
  - `loginUrl`;
  - the OAuth issuer, which `workers-oauth-provider` binds to exactly one
    resource (`docs/security-model.md:209-212`).

**Upsides.**

- The org is the site boundary.
- Orgs get branded URLs.
- BYO maps one to one: `apps.acme.com` stands in for `acme.everyapp.app`.
- One handoff per org instead of one per app.

**Verdict.** B has higher certificate cost or needs Enterprise, still needs
the handoff and the PSL entry, and adds a multi-issuer refactor. Reject it
for now. Revisit only if the hosted zone becomes Enterprise **and**
org-branded hosts become a product requirement. BYO already gives orgs
branded URLs under C.

### 3.3 Scheme C: no shared cookie; per-app-host `__Host-` cookie via handoff

**Layout**

- **Control plane** at `app.everyapp.com`: the gateway host, the OAuth
  issuer, and the hosted MCP connector `https://app.everyapp.com/mcp`. It
  is a first-level subdomain, so Universal SSL covers it, and it can be a
  Workers Custom Domain (1 of 100). Its session cookie is host-only. The
  marketing site stays a separate Worker on the apex.
- **App hosts** at `{app}-{orgKey}.everyapp.app` (domain to be chosen,
  §8 Q1) on their own zone:
  - a proxied wildcard record `* AAAA 100::`;
  - Universal SSL `*.everyapp.app`: free, nothing issued per app, so an
    app is reachable the moment its registry row goes active, and no app
    hostname appears in CT logs;
  - one Worker route `*.everyapp.app/*` to the gateway, with no per-app
    domain limit.

  For BYO, the same zone becomes the Cloudflare for SaaS zone with a `*/*`
  route (§4).
- **App cookie.** Each app host gets
  `__Host-everyapp_session=<random token>` with `HttpOnly; Secure; Path=/;
  SameSite=Lax`. Only the token's hash is stored, in a new D1 table
  `app_sessions`: `{token_hash, session_id → sessions.id ON DELETE CASCADE,
  user_id, organization_id, host, expires_at}`.
  - Deriving a token per host means a leaked app-host token cannot be
    replayed on the control plane or on another host. Copying the parent
    session token onto every host would not have that property.
  - Use `Lax`, not `Strict`: the cookie is set at the end of a cross-site
    redirect chain.

**Handoff flow** (all redirects are top-level navigations, so third-party
cookie blocking does not apply):

1. The browser asks for `https://todo-acme.everyapp.app/notes/42` without
   an app cookie, as an HTML navigation.
2. The perimeter sets `__Host-everyapp_handoff=<nonce>` (`Max-Age=300`) and
   redirects (302) to
   `https://app.everyapp.com/app-session/start?host=todo-acme.everyapp.app&state=<sha256(nonce)>&return_to=/notes/42`.
3. On the control plane:
   - Signed out: `/sign-in?redirect=<this URL>`, then back here.
   - Signed in:
     1. `registry.findByHostname(host)` must be an active app;
     2. check membership in **`app.organizationId`**, the user's ban state,
        and `user_app_access`;
     3. mint a 32-byte code (60 s, single use), stored hashed with
        `{sessionId, userId, orgId, host, stateHash, returnTo}` in the
        verification table, as `mobile-sign-in.ts:189-193` does;
     4. redirect (302) to
        `https://todo-acme.everyapp.app/__everyapp/session?code=…`.
4. The perimeter, on that reserved path:
   1. consumes the code (delete on read) and checks that the stored host
      equals the request host and that `sha256(handoff cookie)` equals
      `stateHash`;
   2. inserts an `app_sessions` row and sets the app cookie;
   3. clears the handoff cookie;
   4. redirects (302) to the path-only `return_to`.
5. On every later request, the authenticator reads the app cookie and runs
   one D1 query joining `app_sessions`, `sessions`, `users` and `members`.
   That replaces today's `getSession`, `resolveOrgContext` and membership
   lookups. It checks:
   - the host binding;
   - that the parent session is live;
   - the ban state;
   - membership in the app's org;
   - app access.

   Signing out, revoking or expiring the parent session kills every app
   cookie on the next request through the cascade.

**Why the nonce matters.** Without it, an attacker could mint a code for
their own session and send a victim the `/__everyapp/session?code=` link.
That is login CSRF, and it bites on any host both of them can open, such
as a shared org's app. This is the browser binding `mobile-sign-in.ts`
already uses (`openedByTheApp` and the secret, `:141-150`). It also means
launcher links cannot skip the first hop. The handoff is two hops on first
visit; that is the price.

**Security properties of C**

- **No tossing onto the control plane.** The control plane is a different
  registrable domain from tenant content, and its cookie is host-only.
  Tenant JS cannot reach it.
- **No fixation across app hosts.** Tenant JS can still write
  `Domain=everyapp.app` cookies until the PSL entry lands, but the gateway
  reads only the `__Host-` name, which no other host can set. Cookie
  bombing of `*.everyapp.app` remains possible until the PSL entry; it
  cannot touch `app.everyapp.com`.
- **Cross-tenant GET riding.** Until the PSL entry, app hosts are still
  same-site, so an evil page's `fetch()` to `y-org.everyapp.app` carries
  y's own host cookie (Lax allows same-site requests). Strip CORS
  credentials at the perimeter (gap G8). The existing same-origin CSRF rules
  still cover non-GET. After the PSL entry, tenants are cross-site, Lax
  withholds the cookie on subresource requests, and riding ends.
- **Org bound per host.** Multi-org users can use every org's apps at once;
  there is no active-org coupling.
- **Unchanged guarantees.** The app never sees a credential (the strip is
  unchanged), and an app must not be able to set the reserved
  `__Host-everyapp_*` names (gap G8).
- **No open redirects.** `/app-session/start` redirects only to registered
  active app hosts, and `return_to` is a path.

**Perimeter change for C (estimate: about 3 engineer-days with agents,
about 600 lines including tests).**

| File | Change |
|---|---|
| `packages/perimeter/src/session.ts` | Add an `AppSessionBroker` dependency: `startHandoff(request, app)` and `completeHandoff(request, app)` (about 30 lines). The `SessionAuthenticator` interface stays. |
| `packages/perimeter/src/gateway.ts` | Reserve `/__everyapp/session` and `/__everyapp/home` next to `isReservedToolsPath` (`:206`), about 25 lines. Replace the `loginUrl` 302 (`:361-371`) with `broker.startHandoff`, about 10 lines. Non-HTML requests without a cookie keep the 401 path. |
| `packages/perimeter/src/headers.ts` | Drop `Set-Cookie` lines with reserved names; strip `Access-Control-Allow-Credentials` and a non-self `Access-Control-Allow-Origin` on private responses (about 25 lines). |
| `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts` | Replace the cookie branch (`:116-130`) with the app-session lookup, and authorize against `app.organizationId` (about 60 lines). |
| New `src/server/app-session/*` and a `/app-session/start` route | Validate the host against the registry and check access; mint the code; implement the broker; add the `app_sessions` migration (about 150 lines). |
| `src/auth/config.ts` | Delete `resolveCookieDomain` and `crossSubDomainCookies` (`:190-221`, `:280-287`), so the session becomes host-only. |
| `src/utils/auth.ts:36-71` | Validate `return_to` against the registry, not "subdomain of the current host". |
| `src/server/app-hosts.ts` | `APP_BASE_DOMAIN` becomes the content domain, independent of the gateway host; update the comments that tie it to the cookie. |
| `apps/mobile-native/src/lib/webview-cookies.ts:73` | Set the control-plane cookie host-only (drop `domain`). App hosts then get their cookies through the handoff inside the WebView. |
| `apps/{todo-app,chef,workout-tracker}/…/gatewayHome.ts` | Link to `/__everyapp/home`, which 302s to `GATEWAY_URL`. |
| Tests | `gateway.test.ts` (handoff, nonce mismatch, reused code, host mismatch, reserved-cookie strip, CORS strip), authenticator, start route. |

**UX cost of C**

- **First visit to each app.** The first open of each app per parent
  session costs two extra redirects through `app.everyapp.com`: three
  short round trips plus one D1 write and one read-and-delete. Later
  visits cost nothing.
- **Signed-out deep links** go app host → start → `/sign-in` → start → app
  host. Today they skip one of those hops.
- **Sign-out** happens once, centrally. Stale app cookies sit in the jar
  but are dead.
- **Expired session in a background request** returns 401 and the app
  reloads, as today.
- **Mobile shell.** It only changes the scope of the cookie it syncs.
  WebViews follow the redirects.
- **PWAs** behave as today, because today's sign-in redirect already
  leaves the app's scope.
- **Chrome's bounce-tracking mitigation** does not apply, because signing
  in to the control plane counts as interaction.
- **Safari ITP** behaviour for a bounce-only control plane has not been
  verified. Users re-authenticate at least as often as the Better Auth
  session expires, which bounds the exposure.
- **`everyapp dev`.** The same flow works on `*.localhost`. Use names
  without the prefix in dev builds, as Better Auth already does by toggling
  `useSecureCookies` on build mode (`config.ts:239,275`).
- **Control-plane cookie name.** A `__Host-` session cookie on the control
  plane is a hardening step for later. It protects against tossing from a
  compromised sibling subdomain of `everyapp.com`, such as the marketing
  site. Better Auth prepends `__Secure-` to any custom name
  (`index.mjs:28-32`), so getting `__Host-` needs `useSecureCookies: false`,
  `advanced.cookies.session_token.name = "__Host-…"` and
  `attributes.secure = true`. This is still to be verified. For the
  prototype, a host-only `__Secure-` cookie is fine, because only our own
  code runs on `everyapp.com`.

**PSL entry for the content domain (at GA)**

What it buys:

- each app host becomes its own site, so `Sec-Fetch-Site` and SameSite see
  other tenants as cross-site and request riding between tenants ends;
- browsers reject `Domain=everyapp.app`, which ends tossing and bombing
  across tenants;
- storage is partitioned per app host;
- browser UI shows the app host as the site.

What it costs:

- no cookie can span app hosts. C needs none.
- the apex `everyapp.app` can only set host-only cookies;
- the request may be declined at prototype scale;
- it takes weeks to months to reach browsers and OS-bundled copies, and
  cannot be expedited;
- removal is slow;
- the `_psl` TXT record must stay in place;
- the domain needs more than 2 years of registration.

The wildcard certificate is unaffected (BR 3.2.2.6, ICANN section only). C
does **not** depend on the PSL for its core guarantees: the PSL closes the
residual GET riding and bombing between tenants.

### 3.4 Side by side

| | A (shared parent cookie) | B (per-org subdomain) | C (per-host cookie + handoff) |
|---|---|---|---|
| App host | `{app}-{org}.app.everyapp.com` | `{app}.{org}.everyapp.app` | `{app}-{org}.everyapp.app` |
| Certificates | ACM $10/mo for `*.app.everyapp.com`, or Universal SSL under A2 | Per-org wildcard: Enterprise wildcard custom hostnames, or ACM packing (≤49 per certificate, re-issued) | Universal SSL `*.everyapp.app`, free |
| App names in CT logs | No (wildcard) | Yes, org keys on every re-issue | No (wildcard) |
| Session reaches app | Shared cookie | Per-org handoff, or a sign-in page per org | Per-app handoff (silent, 2 hops on first visit) |
| Tenant JS fixates control plane | **Yes** (Better Auth parses last duplicate) | No, if the control plane is on another domain | No |
| Tenant JS fixates other tenants | **Yes** | Without PSL, yes for non-prefixed cookies | No (`__Host-`) |
| Cookie bombing | Across the whole brand domain | Across the content domain until PSL | Across the content domain until PSL |
| Cross-tenant GET riding | Yes (all tenants same-site) | Until PSL | Until PSL |
| Multi-org at once | No (active org) without a change | Yes | Yes |
| PSL possible | No (kills the design) | Yes (needed) | Yes (hardening) |
| BYO | Needs C's handoff anyway | Enterprise wildcard, or per-app hostnames | Per-app custom hostnames, same handoff |
| Code delta | ~0.5 day | ~6–8 days | ~3 days for the handoff, ~5 days for the layer |

---

## 4. BYO customer domains

- **Mounting under a path (`acme.com/apps/todo`): no.**
  - The perimeter routes by Host (`packages/perimeter/src/host.ts`,
    `server.ts`).
  - Serving all apps on one origin removes isolation between apps; arch-v2
    cut path mode for exactly this reason
    (`docs/architecture-v2-recommendation.md:22`).
  - A Cloudflare for SaaS custom hostname is a whole hostname. Mounting a
    path would need the customer to run their own reverse proxy.
- **Under C (recommended):**
  - **One-time customer DNS:** `*.apps.acme.com CNAME saas.everyapp.app`,
    or one CNAME per app.
  - **At deploy time:** the gateway calls
    `POST /zones/{everyapp.app}/custom_hostnames` with
    `{hostname: "todo.apps.acme.com", ssl: {method: "http", type: "dv"}}`.
    Real-time validation succeeds once the name resolves to our target,
    the certificate is usually active within 5 minutes, and a
    `app_hostnames` alias row joins the registry.
  - **No custom metadata needed:** the gateway already resolves the Host
    in D1.
  - **Sign-in:** the handoff is identical (the start endpoint accepts any
    registered app host).
  - **Cost:** $0.10/mo per hostname beyond the 100 included, up to 50,000
    without Enterprise.
  - **Zero-downtime cutovers** use TXT pre-validation.
  - **A customer apex (`acme.com`)** needs Enterprise apex proxying, or a
    DNS provider with CNAME flattening.
  - **CT exposure:** each BYO hostname appears in Certificate Transparency
    logs. That is the customer's choice.
  - Whether a wildcard CNAME at the customer's DNS satisfies real-time
    validation for every name under it is not stated in the docs. It
    should, since the name resolves to our target, but check it.
- **Under A:** `apps.acme.com` cannot receive an `everyapp.com` cookie, so
  BYO needs C's handoff. A plus BYO is C plus a second session mechanism.
- **Under B:** `apps.acme.com` would be the org host plus
  `*.apps.acme.com`. That needs a wildcard custom hostname (Enterprise) or
  per-app hostnames, and a per-org handoff to `apps.acme.com`.

---

## 5. App-host `/mcp` and the OAuth own-domain refusal

- **App-host `/mcp`** is unchanged under every scheme for personal access
  tokens (no cookie involved).
  - A browser page calling its own app's `/mcp` uses whatever cookie that
    host has: the shared one under A, the app cookie under C.
  - The rule refusing OAuth tokens on app hosts stays
    (`gateway.ts:209-218`, `headers.ts:84-92`).
  - The hosted OAuth connector is `https://app.everyapp.com/mcp`. Its
    consent page already lets the user pick an org
    (`docs/security-model.md:243-252`).
- **Own-domain refusal**
  (`own-domain.ts:25-35`, today "the gateway host or any subdomain of it"):
  - **Under A1** it works unchanged, because apps sit under the gateway
    host.
  - **Under C** it **must add the content domain** (`everyapp.app` and its
    subdomains). Otherwise an org app's public route on `x.everyapp.app`
    can serve a Client ID Metadata Document. The fetch goes through our
    front door (the reason given at `own-domain.ts:7-12`), and the client
    would show as "verified" on an Every App domain.
  - **For BYO hostnames**, also refuse registered app hostnames (a
    registry lookup), since our gateway is their front door too. Revisit
    if orgs want OAuth clients there.
- **A per-org branded connector** (`apps.acme.com/mcp` as an OAuth
  resource) needs an authorization server that protects many resources. The
  library protects exactly one (`docs/security-model.md:209-212`). Defer
  it. Under C, a personal access token on a BYO app host's `/mcp` already
  works.
- **The identity JWT `iss`** stays `GATEWAY_URL` under C (one issuer).
  B tempts per-org issuers.

---

## 6. Gaps and the smallest change that closes each

| # | Gap | Where | Smallest fix | Days |
|---|---|---|---|---|
| G1 | No content domain or app-host certificate/route for hosted; self-host is deleting wildcard routing | Cloudflare account, hosted gateway config, `app-hosts.ts` | New zone (for example `everyapp.app`): proxied `* AAAA 100::`, Universal SSL, route `*.everyapp.app/*` to the gateway. `APP_BASE_DOMAIN=<content domain>`, decoupled from `GATEWAY_URL`. | 0.5 |
| G2 | `hostnameFor` assumes an install org | `AppRegistrationService.ts:141` | Hosted always uses `{app}-{orgKey}.{base}`. Reserve org keys and app ids that impersonate us (`everyapp`, `app`, `admin`, `login`, `auth`, `api`, `www`). | 0.25 |
| G3 | The session reaches app hosts only through a shared parent cookie (scheme A) | `auth/config.ts:190-221,280-287`; `gateway.ts:361-371`; `betterAuthAuthenticator.ts:116-136` | Scheme C handoff: `app_sessions` table, `/app-session/start`, reserved `/__everyapp/session`, per-host `__Host-` cookie, org bound per host. | 3 |
| G4 | `return_to` and "home" assume apps are subdomains of the gateway | `src/utils/auth.ts:36-71`; `gatewayHome.ts` (3 apps) | Validate `return_to` against the registry; add a perimeter `/__everyapp/home` that 302s to `GATEWAY_URL`. | 0.25 |
| G5 | Own-domain refusal does not cover a separate content domain or BYO hosts | `src/server/mcp-auth/own-domain.ts:25-35` | Refuse `APP_BASE_DOMAIN` and its subdomains, plus any registered app hostname. | 0.25 |
| G6 | App CORS credentials pass through; apps can set reserved cookie names | `packages/perimeter/src/headers.ts:219-255` | On private responses, drop `Access-Control-Allow-Credentials` and any `Access-Control-Allow-Origin` other than the app host; drop app `Set-Cookie` lines named `__Host-everyapp_*`. | 0.5 |
| G7 | Self-host (and A) can be fixated by cookie tossing; the doc claims otherwise | `betterAuthAuthenticator.ts`; `docs/security-model.md:284-285` | Refuse requests whose raw Cookie header repeats the session cookie name (clear and 401); correct the doc. | 0.5 |
| G8 | Mobile shell broadens the session cookie to `Domain=<gateway>` | `apps/mobile-native/src/lib/webview-cookies.ts:61-78` | Host-only for the control plane; app hosts get cookies through the handoff. | 0.1 |
| G9 | No BYO domain support | New `app_hostnames` table, Cloudflare for SaaS API client, status UI | Per-app custom hostnames on the content zone (SaaS enabled, `*/*` route, originless fallback); real-time validation and HTTP DCV; registry alias rows. | 3 |
| G10 | Tenants are same-site, so GET riding and cookie bombing remain | Public Suffix List | Submit the content domain at GA, with the `_psl` TXT record and more than 2 years of registration. | 0.5 (plus weeks waiting) |
| G11 | `findByAppId` assumes a unique app id (adjacent; identity) | `packages/perimeter/src/registry.ts:44-45` | Key by `(organizationId, appId)` or by hostname; the JWT `aud` per org app. Owned by the identity research. | (n/a) |

## 7. Recommendation

**Prototype: build C from the first hosted PR.** The difference from A is
about 3 days. The founder's core feature (orgs deploying their own apps on
Workers for Platforms) is untrusted code by definition. BYO and multi-org
both need the handoff anyway. Suggested order:

1. **H1: hostnames and certificates** (G1, G2, G4, G5). This alone gives
   live app hosts on a wildcard with no certificate waits.
2. **H2: app-session handoff** (G3, G8). Delete `crossSubDomainCookies`.
3. **H3: perimeter hardening** (G6, G7). G7 is worth landing for self-host
   now, independent of hosted.

**Path to GA**

4. **H4: BYO domains** through Cloudflare for SaaS per-app custom hostnames
   (G9).
5. **H5: PSL submission** for the content domain, once the first outside
   org deploys its own app (G10). Treat a rejection as acceptable: C is
   safe without the entry except for same-site GET riding (mitigated by G6
   and the CSRF rules) and cookie bombing confined to the content domain.
6. A `__Host-` session cookie on the control plane.
7. If the hosted zone ever goes Enterprise: wildcard BYO hostnames (one
   per org instead of one per app) and apex proxying for customers who
   want `acme.com` itself.

**Self-host.** Per ADR-0001's "one codebase", consider making C the only
session mechanism, so `APP_BASE_DOMAIN` no longer has to equal the gateway
host. That is a founder call (Q4). At minimum, land G7.

## 8. Open questions only the founder can answer

1. **Which registrable domain hosts tenant apps?**
   - *Why it matters:* it is baked into every app URL, the certificate,
     the PSL entry and the domain's reputation, and it must not be
     `everyapp.com`.
   - *Default:* buy a dedicated `.app` name (for example `everyapp.app`;
     `.app` is HSTS-preloaded). If none is available, use the already-owned
     `everyapp.dev` for the prototype; its apex redirect can stay.
2. **Where is the control plane?**
   - *Why it matters:* the `/mcp` connector URL, the OAuth issuer, the
     sign-in URL, and whether marketing shares a host with authenticated
     pages.
   - *Default:* `app.everyapp.com`; marketing stays on the apex Worker.
3. **Will org-deployed (untrusted) apps be live with outside users during
   the prototype?**
   - *Why it matters:* if yes, scheme A is unsafe from day one.
   - *Default:* assume yes and build C first.
4. **Should self-host also switch to per-host cookies with a handoff?**
   - *Why it matters:* one session mechanism instead of two, and it
     removes the coupling of `APP_BASE_DOMAIN` to the gateway host and the
     mobile shell's cookie broadening. The cost is a redirect on first
     visit in self-host too.
   - *Default:* yes (prototype, no backwards compatibility). At minimum,
     ship G7.
5. **Do catalog apps get per-org hostnames even if one multi-tenant Worker
   serves them?**
   - *Why it matters:* the hostname is the org binding for the cookie, the
     CSRF origin, `/mcp`, and the browser's localStorage and IndexedDB. A
     shared `openseo.everyapp.app` would mix one user's orgs in a single
     origin.
   - *Default:* yes, `openseo-acme.everyapp.app`.
6. **Can the Enterprise arrangement on `openseo.so` extend to the hosted
   zone?**
   - *Why it matters:* it unlocks wildcard custom hostnames (BYO per org,
     and scheme B), apex proxying and custom metadata.
   - *Default:* don't depend on it; ask the account team.
7. **What shape do BYO domains take?**
   - *Why it matters:* paths are impossible without giving up isolation;
     an apex needs Enterprise.
   - *Default:* per-app hostnames under a customer subdomain
     (`todo.apps.acme.com`); no path mounting.
8. **When do we submit to the PSL?**
   - *Why it matters:* small projects are "likely declined", and the entry
     is hard to undo.
   - *Default:* when the first outside org deploys its own app; accept a
     possible rejection.

## 9. Load-bearing claims (if wrong, the design changes)

1. **Cookie tossing into Better Auth fixates the session.** A cookie
   written by script from `x.app.everyapp.com` with `Domain=everyapp.com`
   is sent alongside the gateway's `Domain=app.everyapp.com` session
   cookie, and Better Auth 1.7.7 picks the newer, attacker-supplied value.
   Sources: RFC 6265 §5.3–5.4; `cookie-utils.mjs:157-168`. Verify with a
   two-tab browser test. If wrong, scheme A becomes viable for the
   prototype on CSRF grounds alone, although bombing, reputation and BYO
   still argue for C. **Critical.**
2. **No per-app certificate work under C.** A Free full-setup zone's
   Universal SSL covers `*.<content domain>`, and one Worker route
   `*.<content domain>/*` serves every app host with no per-app
   certificate or domain limit. Sources: Universal SSL limitations
   (2026-10-09); Workers limits; WfP hostname routing. **Critical.**
3. **Cloudflare for SaaS limits off Enterprise.** Wildcard custom
   hostnames and custom metadata are Enterprise-only. Other plans get 100
   hostnames plus $0.10 each up to 50,000. Source: Cloudflare for SaaS
   plans (2026-08-14). This shapes the cost of B and of BYO, not C's core.
4. **The PSL is a hardening step, not a dependency.** A PSL private entry
   can be declined for small projects and cannot be expedited, yet does
   not block wildcard certificates. Sources: PSL wiki Guidelines; CA/B BR
   3.2.2.6. C must therefore stay safe without it.

Also assumed, lower stakes:

- Better Auth can emit a `__Host-` session cookie with a custom name and
  `useSecureCookies: false`.
- A wildcard CNAME at the customer's DNS satisfies real-time validation
  for each custom hostname.
- Safari ITP does not purge cookies of a control plane that users mostly
  reach through redirects.

## 10. Sources

Code (worktree `t3-afce8c8f`, commit `e1d9d3c6`):

- `apps/every-app-gateway/src/server.ts:55-105, 166-252`
- `apps/every-app-gateway/src/auth/config.ts:190-231, 262-287`;
  `src/auth/shared.ts:8-12`
- `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts:108-136`;
  `src/server/organization/orgContext.ts:84-98`
- `apps/every-app-gateway/src/server/app-hosts.ts:4-44`;
  `src/server/services/AppRegistrationService.ts:120,141,215-252`
- `apps/every-app-gateway/src/server/mcp-auth/own-domain.ts:1-35`;
  `authorize.ts:96,117`; `consent.ts:130`; `routes.ts:209`
- `apps/every-app-gateway/src/server/toolbus/app-host-mcp.ts:68-75`;
  `src/server/control-plane-guard.ts:1-17`; `src/utils/auth.ts:36-71`
- `apps/every-app-gateway/src/auth/cloudflare-access/mobile-sign-in.ts:1-30,141-198`
- `packages/perimeter/src/gateway.ts:114-118,194-218,244-287,361-371`;
  `csrf.ts:31-99`; `headers.ts:44-59,84-92,179-255`; `host.ts:18-34`;
  `registry.ts:28-45`; `session.ts:11-47`; `getAppFetcher.ts:54-56`
- `apps/mobile-native/src/lib/webview-cookies.ts:15-78`;
  `apps/todo-app/src/client/lib/gatewayHome.ts:10-16`
- `apps/every-app-gateway/node_modules/better-auth/dist/cookies/index.mjs:20-38`;
  `cookie-utils.mjs:157-168` (better-auth 1.7.7)
- `docs/architecture-v2-recommendation.md:22,73,105,174`;
  `docs/security-model.md:165-174,209-252,284-285`;
  `docs/cli-redesign.md:660-662`
- Branch `everyapp-com`: `landing-page/wrangler.jsonc`, commit `e82ac711`.
- Cloudflare API `GET /zones` (2026-10-15): the zones and plans listed in
  §1.8.

Web:

- Universal SSL limitations (updated 2026-10-09): https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- Advanced Certificate Manager: https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
- ACM price ($10/mo) and Cloudflare for SaaS pricing: https://www.cloudflare.com/plans/network-cdn.md
- Total TLS (2026-04-16): https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
- Workers Custom Domains (2026-09-29): https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Workers limits (routes and domains, headers): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare for SaaS plans (2026-08-14): https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
- Workers as your fallback origin: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/
- WfP hostname routing (2026-09-24): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/
- Getting started, Cloudflare for SaaS: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/
- Pre-validation: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/
- Real-time validation (2026-04-15): https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/realtime-validation/
- HTTP DCV for custom hostnames: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/
- TXT DCV for custom hostnames: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/txt/
- DCV backoff schedule (2026-06-19): https://developers.cloudflare.com/ssl/edge-certificates/changing-dcv-method/validation-backoff-schedule/
- Header limit changelog (2025-10-16): https://developers.cloudflare.com/changelog/post/2025-10-16-header-limit-increase/
- CA/B Forum Baseline Requirements v2.3.1 (BR 3.2.2.6, definitions): https://github.com/cabforum/servercert/blob/main/docs/BR.md
- RFC 9525 §6.3 (wildcards): https://www.rfc-editor.org/rfc/rfc9525#section-6.3
- RFC 6265 §5.3, §5.4, §6.1: https://www.rfc-editor.org/rfc/rfc6265
- PSL guidelines: https://github.com/publicsuffix/list/wiki/Guidelines
- PSL third-party diffusion: https://github.com/publicsuffix/list/wiki/Third-Party-Diffusion
- PSL, learn more: https://publicsuffix.org/learn/
- MDN Set-Cookie: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- MDN Document.cookie: https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie
- MDN Site glossary: https://developer.mozilla.org/en-US/docs/Glossary/Site
- caniuse, `__Http-` and `__Host-Http-` prefixes: https://caniuse.com/mdn-http_headers_set-cookie_http_host-http_prefixes
- GitHub, "New GitHub Pages domain: github.io" (2013-04-05): https://github.blog/2013-04-05-new-github-pages-domain-github-io
- GitHub, "Yummy cookies across domains" (2013-04-09): https://github.blog/2013-04-09-yummy-cookies-across-domains/
- Chrome bounce tracking mitigations (dev trial): https://developer.chrome.com/blog/bounce-tracking-mitigations-dev-trial
