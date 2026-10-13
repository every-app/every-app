# Security Model

## Trust Zones

- **Client zone:** untrusted browser, API, and webhook traffic.
- **Gateway zone:** the only public Worker; terminates Better Auth sessions,
  enforces app access, and injects signed identity.
- **App zone:** private Workers invoked by the gateway over service bindings.

## Perimeter Contract

- Routes are private unless the app manifest explicitly declares them public.
- The gateway strips `Cookie` and every inbound `x-everyapp-*` trust header on
  both public and private routes. Apps must never trust client-supplied Every
  App headers.
- Private routes also strip inbound `Authorization`, require a valid gateway
  session and app access, then receive a fresh RS256 identity JWT in
  `x-everyapp-identity`.
- Public routes forward inbound `Authorization` so the app can implement its
  own bearer-token API or webhook authentication. The gateway does not
  interpret that header and never treats it as Every App identity.
- Anonymous public requests receive a signed public marker. A signed-in member
  may receive user identity on a public route only after the normal session,
  organization, app-access, and CSRF checks succeed.
- Failed CSRF checks deny private state-changing requests. On declared public
  routes they force anonymous handling so cookies cannot confer member
  identity to a cross-site request.
- TanStack Start server functions (`/_serverFn/*`) only answer same-origin
  `fetch()` calls from TanStack's client, on every method: navigations,
  any `Sec-Fetch-Site` other than `same-origin`, and requests without the
  client's `x-tsr-serverFn` / `x-tsr-redirect` header are rejected before
  auth. The path is decoded the way Start decodes it (each valid `%XX` on
  its own when another escape is malformed). An app whose server functions
  live elsewhere (a router basepath or its own `serverFns.base`) declares
  the path with `serverFnBase`; an app can opt out with
  `serverFnGuard: false` in its manifest.
- A cookie-authenticated WebSocket upgrade must come from the app's own
  `Origin`; bearer-only upgrades are exempt.
- The gateway strips an inbound `Cloudflare-Workers-Version-Overrides`
  header, so clients cannot choose which app version answers.

## Control Plane

- The gateway's own host applies the same server-function rule and requires a
  same-origin `Origin`/`Sec-Fetch-Site` on every cookie-carrying
  state-changing request (the native shell's exact `everyapp://` origin and
  token-authenticated deploy and OAuth endpoints are left to their own
  checks). Every response gets HSTS for the gateway host alone (no
  `includeSubDomains`: the gateway often runs on the customer's apex
  domain), `nosniff`, frame denial, `Referrer-Policy: no-referrer`, and
  `Cache-Control: no-store` on admin, consent, setup and reset pages.
- A fresh gateway has no owner and accepts no sign-ups or organizations until
  it is claimed with the one-time setup link the deployer's CLI mints into D1.
  Members cannot create organizations; app registration requires the app's
  own worker name (`every-<appId>`), never the gateway's.
- Invite links carry their own random secret (only its SHA-256 is stored);
  signing up through an invitation and joining with one both need it, never
  just the invitation id. Better Auth's accept, list-invitations and
  get-full-organization endpoints are closed over HTTP, so members are never
  sent pending invitations.
- The OAuth authorization server is off unless `MCP_OAUTH_ENABLED` is
  `"true"`: its endpoints and discovery documents return 404 and only
  personal access tokens (`epat_`) authenticate bearer requests. Turning it
  on: `docs/runbooks/mcp-oauth.md`.
- The AI proxy only forwards inference endpoints (with `store: false` for
  responses and chat completions). The provider key is shared by every app,
  so anything else needs both the operator's allowlist (the
  `AI_PROXY_EXTRA_ROUTES` gateway secret, e.g. `/v1/files`) and the app
  manifest's `ai.routes`; `ai.models` can restrict models.

## App Verification Contract

- Apps verify the signature, issuer, audience, token type, and key id before
  using identity. The production identity key id is `everyapp-identity`.
- User identity is organization-bound; the gateway denies access when the
  active session organization does not own the target app.
- Missing, invalid, expired, or wrong-audience identity fails closed.

## Response Contract

- The gateway removes `Domain` from app `Set-Cookie` headers so apps cannot set
  parent-domain cookies.
- HTML responses receive the perimeter CSP floor (`frame-ancestors 'none'`,
  `base-uri 'self'`, `object-src 'none'`) without a blanket `default-src`.
- HSTS, `nosniff`, frame denial, and referrer policy are applied uniformly.
- Structured gateway events (`logEvent`: setup claims, invitations, member
  changes, AI usage and upstream failures, proxied requests, unhandled
  server-function errors) go through a logger that redacts `cookie`,
  `authorization`, `set-cookie` and any token, secret, password or code
  field. Other error logs (perimeter and app failures) record an error's
  message and stack as thrown, so errors must not put credentials in their
  messages.
