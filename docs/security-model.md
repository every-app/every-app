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
