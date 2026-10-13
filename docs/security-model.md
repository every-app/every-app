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
  interpret that header and never treats it as Every App identity. Every
  App's own bearers are never forwarded: a personal access token (`epat_…`)
  or a token of the gateway's OAuth server authenticates, or the request
  fails closed.
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
  the token-authenticated deploy API, `/mcp`, and OAuth token and
  registration endpoints are left to their own checks; none of them reads
  the session cookie). Every response gets HSTS for the gateway host alone
  (no `includeSubDomains`: the gateway often runs on the customer's apex
  domain), `nosniff`, frame denial, `Referrer-Policy: no-referrer`, and
  `Cache-Control: no-store` on admin, OAuth, setup and reset pages.
- A fresh gateway has no owner and accepts no sign-ups or organizations until
  it is claimed with the one-time setup link the deployer's CLI mints into D1.
  Members cannot create organizations; app registration requires the app's
  own worker name (`every-<appId>`), never the gateway's.
- Invite links carry their own random secret (only its SHA-256 is stored);
  signing up through an invitation and joining with one both need it, never
  just the invitation id. Better Auth's accept, list-invitations and
  get-full-organization endpoints are closed over HTTP, so members are never
  sent pending invitations.
- The OAuth authorization server for MCP clients is on unless
  `MCP_OAUTH_ENABLED` is `"false"`, the kill switch: then its endpoints and
  discovery documents return 404 and only personal access tokens (`epat_`)
  authenticate the gateway's `/mcp`. See `docs/runbooks/mcp-oauth.md` and
  "Connected AI apps (OAuth)" below.
- The AI proxy only forwards inference endpoints (with `store: false` for
  responses and chat completions). The provider key is shared by every app,
  so anything else needs both the operator's allowlist (the
  `AI_PROXY_EXTRA_ROUTES` gateway secret, e.g. `/v1/files`) and the app
  manifest's `ai.routes`; `ai.models` can restrict models.

## Agent Tools (MCP)

- Two endpoints serve the same tools: the gateway's own `/mcp`, one
  connector for every app a user reaches (tools named `<app>_<tool>`, plus
  the read-only built-ins `everyapp_whoami` and `everyapp_list_apps`), and
  each app host's `/mcp`, for that app alone under its tools' own names.
  Both are served by the gateway's ToolBus from the tool catalogs it
  snapshots in D1 at deploy (apps declare them with `defineTools()`).
  Listing tools never calls an app; each tool call is one call over the
  app's service binding.
- The gateway's `/mcp` takes an OAuth access token issued by the gateway
  (see below) or a personal access token, never a cookie. It serves the
  active apps of the caller's organization they have access to, narrowed to
  the apps an OAuth connection chose or the one app a token is bound to. A
  browser may call it only from the gateway's own origin or an origin listed
  in `MCP_ALLOWED_ORIGINS` (empty by default).
- An app host's `/mcp` needs a personal access token or the user's browser
  session; it takes no OAuth token and advertises no authorization server
  (its protected-resource metadata paths answer 404).
  Token scopes set access: `*` or `mcp:write` is read & write, `mcp:read` is
  read only, anything else is refused with `403 token_scope`. A browser
  session is read & write. Destructive tools are hidden and refused for
  everyone; write tools are hidden from read-only callers.
- A browser session reaches `/mcp` only from the app's own pages: it is
  intended (an app may call its own tools), and the usual CSRF check guards
  it. A cookie-carrying POST needs `Sec-Fetch-Site: same-origin`, or without
  that header an `Origin` on the app's host; a sibling app's page
  (`same-site`) or any other site gets `403 csrf_denied` before a tool runs.
  Only a POST makes the gateway call the app (to sync a missing catalog), so
  the GETs a sibling page can send with the cookie never do.
- A token whose scopes are all `mcp:` scopes is MCP-only: every app route
  other than `/mcp` (public ones included) answers it `403 token_scope`, so
  an `mcp:read` token stays read only even though apps don't check scopes on
  their own routes. Tokens holding `*` (what a token created without scopes
  gets) or any non-MCP scope keep working on every route.
- Each call carries a fresh identity minted for that call alone:
  `chan: "mcp"`, explicit `mcp:*` scopes (never `*`, never
  `mcp:destructive`), and a `tc` claim naming the tool and call id. The SDK
  refuses a tool call without it, or whose scopes don't cover the risk the
  tool declares.
- The internal tools endpoints (`/__everyapp/tools/list` and `/call`) answer
  404 to every outside request, however the path is encoded. The catalog
  endpoint only accepts the gateway's one-minute, one-purpose system token
  (`x-everyapp-system`), which is never an identity and can't call tools.
- A browser may call an app's `/mcp` only from the app's own origin; any
  other `Origin` gets 403. Cross-origin browser clients (MCP Inspector's
  direct mode, say) aren't served on app hosts: their CORS preflight carries
  no credentials, so the perimeter answers it 401. `everyapp dev` answers
  preflights from localhost origins, so the Inspector works locally.
- The gateway checks a call's arguments against the snapshotted schema
  before calling the app, in bounded time: it never runs an app's regular
  expressions (`pattern`, `patternProperties`), and leaves recursive schemas
  and arguments with more than 1,000 values to the app, whose SDK validates
  every call with the tool's own schema. Arguments nested more than 64
  levels deep are refused, JSON-RPC batches are refused, and an app gets 30
  seconds (headers and body) to answer a call.
- Each tool call, on either endpoint, logs one `mcp.tool_call` line and
  writes one `mcp_tool_calls` row with a keyed digest of the arguments,
  never the arguments or the result, including calls refused for their
  arguments. An hourly cron deletes rows older than
  `MCP_AUDIT_RETENTION_DAYS` (90 by default).

## Connected AI apps (OAuth)

- The gateway is an OAuth 2.1 authorization server
  (`@cloudflare/workers-oauth-provider` 1.2) for exactly one protected
  resource, `${GATEWAY_URL}/mcp`, whose metadata names that exact URL.
  Tokens are bound to it and work nowhere else: an app host refuses them,
  and never forwards one to an app, even on a public route.
  Every client must use S256 PKCE; redirect URIs must be https or loopback
  http, and neither a client id nor a redirect URI may be on the gateway's
  own domain (its host or an app host under it): the authorization
  endpoint, the consent page and the token endpoint all refuse one before
  anything is fetched. An invalid authorization request is answered on the
  gateway's own page, never redirected to the client: registration is open,
  so a redirect could go anywhere.
- Clients identify themselves with a Client ID Metadata Document (an https
  URL on a domain they control, which the consent page shows as verified
  only when access goes to that domain, a subdomain of it or an app on the
  user's computer; otherwise it warns that access goes to a different site,
  since anyone can host a file on some big domains) or register dynamically (their name is shown as unverified, without
  control characters and clipped). Metadata documents are fetched under the
  `global_fetch_strictly_public` compatibility flag, which routes every
  fetch as a request from the internet would go, through Cloudflare's front
  door, never straight to an origin behind a zone. That doesn't keep a
  fetch away from the gateway's own zone: its front door is the gateway
  itself, so a document served from an app's public route would come back
  as a "verified" client. That is why client ids on the gateway's own
  domain are refused, not fetched. A dynamic registration that names no
  token endpoint authentication method is registered as a public client.
- Dynamic registration is anonymous, and each one is a write to the
  account's KV, whose writes every namespace shares. So it keeps only what
  the gateway uses (at most 16 KiB in, the name cleaned and clipped, ten
  redirect URIs), for 60 days without use, and is limited to 5 a minute
  per client address in each isolate, 20 a day per address and 200 a day
  per gateway (counted in D1, where a refused request writes nothing).
  `MCP_DCR_ENABLED=false` turns it off for gateways whose users only need
  clients with metadata documents.
- Consent: `/oauth/authorize` validates the request before anything else
  and sends a signed-out user to sign in first. The consent transaction is
  single-use, expires in ten minutes and is bound to the browser that
  started it by a `__Host-` cookie; the decision is a same-origin form POST
  from a signed-in user. Consent pages are never cached or framed and send
  no Referer. The page shows where access will be sent, warns when that is
  an app on the user's computer, and lets the user choose the organization,
  all apps (including future ones) or chosen ones, and read & write or read
  only.
- Each approval is an `mcp_connections` row; the tokens carry only its id,
  the user's and the organization's. Every `/mcp` request re-reads the row,
  the user's membership and role, their ban state and their app access, so
  revoking a connection, removing or deactivating the member, or removing
  an app takes effect on the next request; a refresh for a connection that
  no longer stands fails with `invalid_grant` and revokes the grant. Read
  only connections never see write tools.
- Users list and revoke their connections at `/settings/connections`.
  Removing a member revokes their connections in that organization, and
  deactivating a user revokes all of theirs, grants included. Connecting
  the same client again replaces the earlier connection and its grant
  (for a metadata document client, the same installation's: same redirect
  URI, a loopback redirect's port not counting).
- Refresh tokens rotate on every use, but the library accepts the token
  before the latest one until the latest is used (so a client that lost a
  refresh response can retry), and it has no reuse detection: a replayed
  refresh token never revokes its grant. A stolen refresh token can
  therefore mint access tokens alongside the client for a while.
  `@cloudflare/workers-oauth-provider` 1.2.3 has no option for stricter
  rotation. Revoking the connection, removing the member or deactivating
  the user ends it at once, since every refresh re-checks the connection.

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
