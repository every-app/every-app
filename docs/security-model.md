# Security Model

## Trust Zones

- **Client zone:** untrusted browser, API, and webhook traffic.
- **Gateway zone:** the only public Worker; terminates Better Auth sessions
  (and, on third-party app hosts, per-host sessions), enforces app access,
  and injects signed identity.
- **App zone:** private Workers invoked by the gateway over service bindings,
  or (hosted, third-party apps) Workers in a Workers for Platforms dispatch
  namespace the gateway dispatches to. Either way through one seam,
  `getAppFetcher` (`packages/perimeter/src/getAppFetcher.ts`).
  An app's helper Workers (its manifest's `workers`, deployed as
  `<app worker>--<name>`) are in the app zone as the app: the gateway never
  binds them, only the app's own Worker may (a service binding, or the
  Durable Objects and Workflows a helper defines), and a helper binds only
  the gateway's AppGateway, with the app's own props. The deploy checks
  each one against the same policy as the app's Worker (private, no routes
  or domains, only the app's own resources, Workflows named after the app's
  Worker) and refuses a built Worker the manifest doesn't declare.
  Helpers verify no identities: the gateway never calls one, so the app's
  Worker verifies the request and hands the helper what it needs (ids as
  headers, RPC arguments or Workflow params; Postiz's API helper reads the
  app's `x-postiz-identity` header). The rule that only the app's own Worker
  may bind a helper is what makes that safe, and a helper's `scheduled` and
  Workflow code runs with no identity, as an app's does.
  A Hyperdrive binding is allowed only to a config the deploy provisioned
  for the app (`<app worker>--<binding>`, recorded in the app's resource
  ledger): created from, or adopted only when it connects to, the origin in
  the app's `.everyapp/secrets.env`, so binding it gives the app no database
  it couldn't already reach. The origin URL reaches `cf` and drizzle-kit only
  in a private file or the environment, never argv or output. The dispatch
  tier refuses Hyperdrive (`manifestTierProblems`).
  An app deployed from a release (`everyapp deploy <github url | tarball>`)
  is held to the same rules: its tenant-neutral Build Output gets the same
  install rewrite and policy check as a local build, and its manifest the
  strict parser. The release's SHA-256 proves only that the tarball is
  whole, not who built it: whoever deploys a release trusts its publisher
  as they would trust the repository's code. The CLI never builds a
  repository from its URL (a repository without a release is cloned and
  deployed from its directory), so no one else's build scripts run on a
  deployer's machine.

## Deployment Mode

`GATEWAY_DEPLOYMENT_MODE` (`everyapp setup --mode`, a secret set with the
first upload; ADR-0001) decides what the gateway does, once, in
`platformPolicy(env)` (`apps/every-app-gateway/src/server/platform-policy.ts`):

- `self_hosted`: invite-only sign-up, Cloudflare Access sign-in when
  configured, the setup claim, tenant admins manage their members' accounts,
  dynamic client registration 20 a day per address and 200 per gateway.
- `hosted`: our own install of the same gateway, with open sign-up into
  personal organizations and verified email, shared first-party apps, no
  Access sign-in (its settings are ignored and its plugin is not
  registered), the setup claim (the first owner's organization is the
  platform organization, named Every App), registration 200 a day per address and 20,000 per
  gateway, and tenant admins can't act on accounts (deactivate, reactivate,
  reset a password, delete one): removing a member keeps the account.
  Third-party deploys stay off behind a launch gate.
- Anything else, unset included, is `invalid`: every capability off, hosted
  and self-hosted alike: no setup claim, no Access sign-in, no app
  activation, no dynamic registration, no account actions, no outbound
  mail. Local dev builds default to `self_hosted` (`cloudflare.config.ts`).

### Hosted sign-up

- Open sign-up starts only once the gateway is claimed (before that a
  stranger's personal organization would make them an owner first). The
  operator setting `HOSTED_OPEN_SIGNUP=false` keeps it invite-only (any value
  but unset or `"true"` does, so a typo closes it); self-hosted is always
  invite-only.
- An invite link, when a sign-up carries one, is checked as on self-host
  (live, same email, its secret not the invitation id), and an invitee gets
  no organization of their own: they join only the inviting one.
- A sign-up without one gets exactly one personal organization (named after
  the person, else their email's local part; at most 64 characters and no
  control or invisible formatting characters; slug plus 6 random
  characters; marked `{"personalFor": <user id>}` in its metadata) and an
  owner membership, written in one D1 batch. If it fails, the account is
  deleted and the sign-up fails: no account without its organization.
  Members still can't create organizations (`allowUserToCreateOrganization`
  off); a server-side sign-up (the setup claim) gets none.
- Accounts sign in only once their email is verified. The verification link
  (Better Auth's, a signed token in the query string, 24 hours) signs the
  account in once. The setup claim's owner is verified by the claim. A
  hosted gateway that can't send email refuses every sign-up with
  `EMAIL_NOT_CONFIGURED` (503) before writing anything, and logs
  `auth.sign_up_refused`. Only a verified account may invite.
- Every session starts in an organization when the user has one: their
  personal one, else the one their latest session was in (if still a
  member), else the first they joined. A session without one still falls
  back only to a sole membership, never a guess between several.

### Outbound mail

- Every email (`verification`, `reset`, `invitation`) counts against daily
  budgets per kind, per recipient (an HMAC of the address, never the
  address) and for the whole gateway, in `rate_limit_counters`, before it
  is sent: 5 per address and 2,000 / 1,000 / 2,000 per gateway when hosted,
  10 and 1,000 each when self-hosted, none when the mode is invalid. A
  budget that can't be read or written sends nothing. Verification mail
  that can't go fails nothing: the resend answers the same whether or not
  it sent, so it doesn't tell whether an address has an account (Better
  Auth also limits it to 3 a minute per client).
- Every value interpolated into an email is HTML-escaped, and kept to one
  line in subjects and text (`server/email/templates.ts`): organization
  names and inviter addresses are user input.
- Apps send mail through the gateway's `email` capability
  (`server/capabilities/email.ts`), never a `send-email` binding of their
  own (the deploy refuses one): the deployed manifest must list `email`
  with `write`, an agent's identity needs `mcp:write`, and app mail counts
  against its own `app` budgets, once per distinct recipient (100 per
  address and 5,000 per gateway a day self-hosted, 20 and 5,000 hosted; no
  per-organization budget). Recipients are the app's to choose. The From is
  the gateway's sender unless it matches one of the installation's senders
  (`apps.email_senders`, `*@domain` or one address, set with
  `everyapp email set` by whoever can deploy, never by the manifest, so a
  release carries no domain); a hosted gateway refuses any app sender, so
  one organization's app can't send as the platform or as another's
  domain. Headers that would set the sender,
  recipients or subject (`From`, `Sender`, `Reply-To`, ...) are refused,
  values with line breaks too, and the rest pass through to Email Sending.
  Logs (`email.app.send`) carry counts, an HMAC of the first recipient and
  the outcome, never subjects, bodies, attachments or addresses.
- Apps read their organization's members through the gateway's `members`
  capability (`server/capabilities/members.ts`): the deployed manifest must
  list `members` with `read`, the organization is the call's attribution
  (an organization's own app reads only its own), and the list holds only
  people the perimeter would let open the app (not deactivated, an active
  organization, granted an organization's own app). An agent's tool call
  is refused, so a connected agent can't page through the directory. Logs
  (`members.app.list`) carry the count, never an address.
- Inbound mail reaches an app's `email()` handler from an Email Routing rule
  that names its Worker, outside the perimeter: no identity, and anyone can
  mail the address, so the handler treats the message as untrusted input
  (its `From` is whatever the sender wrote) and its gateway calls name the
  organization with `for: { background: true, organizationId }`; a reply
  sent from it goes through the `email` capability and its budgets like any
  other. The deploy keeps refusing the `email` trigger; the CLI
  makes the rules from the installation's inbound addresses instead
  (`everyapp email set --inbound`, and every deploy reconciles them),
  recorded in the ownership ledger, so it takes only an address no other
  app recorded and no foreign rule or catch-all delivers, never turns Email
  Routing on for a domain without a person's yes (or
  `--enable-email-routing`), and `--purge` removes only the routes the app
  recorded. The manifest only declares the handler
  (`email: { inbound: true }`), so an installer inherits no address. Apps
  on the dispatch tier declare no inbound mail (the hosted deploy API
  refuses it; docs/runbooks/email-sending-setup.md).

## Organizations and Shared Apps

- Every request acts under one organization, and the identity JWT carries
  it (`org_id`, `org_role`). An organization whose `status` isn't `active`
  (the platform `suspended` it) opens nothing for anyone acting under it:
  its members' browser sessions and personal access tokens get 403 on every
  app host, its own apps and shared ones; its org-scoped control-plane
  server functions refuse with `ORGANIZATION_SUSPENDED` and `/api/me/apps`
  with 403; its AI connections and personal tokens are refused on the
  gateway's `/mcp` (403, `organization_suspended`) and it is offered no
  new connection. The status is cached per isolate for up to 30 seconds,
  like memberships.
- An organization's own app (`scope = 'org'`, every app on a self-hosted
  gateway) opens for a member of that organization with the app installed
  for them (a `user_app_access` row). A browser session acting under
  another of the person's organizations is let in as their membership in
  the app's organization: the JWT carries the app's organization and their
  role there, never the session's. A personal access token only ever acts
  in its own organization (and, bound to an app, in that app only).
- A shared app (`scope = 'shared'`, the hosted gateway's first-party apps)
  is a registry row of the platform organization (the install organization,
  "Every App"), at `<appId>.<APP_BASE_DOMAIN>`, on a service binding, one
  Worker for every organization. Any live member of any active
  organization opens it, with no `user_app_access` row, acting under their
  session's organization: the JWT carries that organization, and the app
  scopes its data by it. Only `platformPolicy(env).sharedApps` (hosted)
  honours the scope: elsewhere a shared row opens for nobody. Shared apps
  are listed in every organization's launcher, AI-connection consent and
  gateway `/mcp` catalog, and read-only in other organizations' Admin →
  Apps; nobody manages their access, and only the platform organization's
  owners and admins edit or delete them.
- The registration rules give a shared app only to the install
  organization and never change an app's scope (a redeploy that names none
  keeps the row's; the same id asked for as the other scope is refused,
  tombstones included). The CLI registers, redeploys or deletes one
  (`everyapp deploy --shared`, `everyapp register`,
  `everyapp delete`) only on a gateway whose install row records `hosted`
  (deletes aside), and only for a Cloudflare login that is an owner or admin
  of the platform organization by its verified email (an API token is the
  account's own authority, as below). `secret set|unset` change the live
  Worker without a deploy since #321 and check neither yet; the Cloudflare
  login they take can change the Worker's secrets through cf directly
  (TODO.md, Build). A shared app's manifest, the names under `secrets`
  included, is read-only visible to every organization's admins in Admin →
  Apps (names, never values).
  A shared app's Worker gets no `EVERY_APP_ORG_ID`: nothing pins it to the
  platform organization.
- Machine-path attribution: the AppGateway entrypoint decides which
  organization a provider call (AI proxy or capability) is attributed to,
  and logs where it came from (`orgSource`):
  - An organization's own app (`scope = 'org'`: every self-hosted app, and
    dispatched apps) calls for the organization in its binding's
    upload-time props (`props`). A forwarded identity of that organization
    names the user; one that doesn't verify or names another organization
    is ignored (the call is the app's). An `x-everyapp-org` naming any
    other organization is refused (403 `caller_org_mismatch`); the
    directory of organizations is never consulted.
  - A shared app serves every organization. With a forwarded identity
    (`x-everyapp-identity`), the verified JWT's `org_id` decides (`jwt`): an
    invalid or expired one is 401 `caller_identity_invalid`, never a
    fallback to the platform organization. Without one, the call is
    background work (a cron, a Workflow step) and must name its
    organization in `x-everyapp-org` (`header`), else 403
    `caller_identity_required`; the organization must exist, be `active`
    and have at least one member who isn't deactivated, else 403
    `caller_org_not_attributable` (cached per isolate like callers: 30
    seconds for a yes, 5 for a no; a lookup that fails is 500). With both,
    they must agree, else 403 `caller_org_mismatch`. The header is trusted
    only because a shared app is first-party code we deploy; it names no
    user, so the call is the app's.
  - Browsers can't send it: the perimeter strips every inbound
    `x-everyapp-*` (`x-everyapp-org` included) before an app sees the
    request, and the gateway strips it before a provider does.
  - A capability's status (`GET /api/integrations/<id>`) calls no provider
    and names no organization's data, so it needs no attribution.
  - The SDK's `createGatewayFetch` and `integrationFetch` take `for: request`
    (forward the identity) or `for: { background: true, organizationId }`
    (send `x-everyapp-org`, no identity), and in a shared app's Worker
    (`EVERYAPP_SHARED=1`) throw `AttributionError` for a call that names
    neither. The gateway enforces the rule either way.
- No per-organization usage limits yet, in any mode: every provider call
  (AI proxy or capability) is attributed to an organization (from the
  props, the forwarded identity or `x-everyapp-org`, as above) and logged
  with it, and nothing is counted or refused on volume. Metering (the
  wallet) is a later feature; until then nothing at the gateway bounds an
  organization's provider spend, so the hosted preview stays invite-only
  (`HOSTED_OPEN_SIGNUP=false`).

## Operator Authority (Self-Host)

ADR-0003. In `self_hosted` mode, write access to the gateway's D1 database
in the gateway's Cloudflare account **is** operator authority.

- The CLI reads and writes the app registry (`apps`, `user_app_access`,
  `organization_keys`), the install row, the deploy lease, the resource
  ledger and the owner setup link with `cf d1 query`, under the operator's
  own Cloudflare login or API token. The gateway issues no deploy
  credential and has no deploy API: nothing on the public Worker accepts a
  registration, a deploy or a delete.
- The registration rules live once, as pure functions in
  `@every-app/perimeter/registry`, and the CLI runs them before every write:
  reserved and malformed app ids, the Worker name `every-<orgKey>-<appId>`
  (never one of the gateway's own names, at most 63 characters), D1 and KV
  names derived from it, the hostname, takeover checks against existing
  rows (a deleted app's tombstone keeps its names), and initial access (the
  deployer, owners and admins; everyone with `access: "everyone"`). The
  gateway still validates the manifest it reads from a row and treats an
  unknown status as disabled; a row whose `tier` isn't `service_binding` or
  `dispatch`, or whose `scope` isn't `org` or `shared`, is never routed (a
  503 on its host), never read as another tier or scope. A hand-written row that breaks a rule is the
  operator's doing, as a hand-edited Worker is.
- The gateway activates apps itself: a `binding` app (its Worker uploaded)
  becomes `active` on the first request that reaches the Worker over a
  service binding of the gateway version serving that request. A `pending`
  app is never bound or activated, a disabled or deleted one is never
  switched back on, and only `GATEWAY_DEPLOYMENT_MODE=self_hosted` or
  `hosted` activates (any other value, unset included, fails closed).
- Every deploy records its actor on the app row (`deployed_by_actor`, with
  `deployed_at`): the Cloudflare login's email, or `api-token:<account id>`
  in CI. Admin → Apps shows it. There is no deploy event log.
- Revocation is Cloudflare's alone. Removing, banning or deactivating a
  gateway member doesn't stop them deploying while they still hold the
  Cloudflare login or an API token for the account. Any Cloudflare API
  token with D1 write on the account is an operator, including the token an
  app's CI uses to upload Workers; such a token could already redeploy the
  gateway Worker or write `owner_setup_tokens`. Compromise of the Cloudflare
  credential carries account-wide blast radius.
- This trust model is not valid for the hosted tier (ADR-0001), which needs
  its own HTTP control plane and credentials: the deploy API for
  third-party apps ("Hosted Deploy API", below). A self-hosted gateway
  never serves it.

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
- Cookie tossing: any host under the session cookie's registrable domain (a
  sibling subdomain, or an app setting a host-only cookie on its own host)
  can plant a second cookie with the session cookie's name, and the browser
  sends both in an order the planter controls. A request whose `Cookie`
  header names the session cookie (`better-auth.session_token`, with or
  without `__Secure-`) more than once, however the copies are ordered or
  scoped, is refused with `401 duplicate_session_cookie` before anything is
  authenticated, on every app route (public ones included) and on the
  gateway's own host. A single copy works as before. Third-party hosts
  apply the same rule to their own session cookie, `__Host-everyapp_s`,
  which no sibling host can plant (`__Host-` cookies carry no `Domain`).

## Control Plane

- The gateway's own host applies the same server-function rule and requires a
  same-origin `Origin`/`Sec-Fetch-Site` on every cookie-carrying
  state-changing request (the native shell's exact `everyapp://` origin and
  the token-authenticated `/mcp` and OAuth token and registration endpoints
  are left to their own checks; none of them reads the session cookie). Every response gets HSTS for the gateway host alone
  (no `includeSubDomains`: the gateway often runs on the customer's apex
  domain), `nosniff`, frame denial, `Referrer-Policy: no-referrer`, and
  `Cache-Control: no-store` on admin, OAuth, setup and reset pages. A
  request carrying the session cookie twice is refused before any of this
  (see cookie tossing under the perimeter contract).
- A fresh gateway has no owner and accepts no sign-ups or organizations until
  it is claimed with the one-time setup link the CLI mints into D1 with the
  operator's Cloudflare login. Apps may be deployed before then (a CI-first
  install): the claim makes the first owner the owner of the organization
  they were deployed to and gives them every app in it nobody has access
  to. Members cannot create organizations (a hosted sign-up's personal
  organization is the gateway's doing, above). On a gateway whose deployment
  mode is invalid the claim is refused (`SETUP_UNAVAILABLE`).
- Invite links carry their own random secret (only its SHA-256 is stored);
  signing up through an invitation and joining with one both need it, never
  just the invitation id. Better Auth's accept, list-invitations and
  get-full-organization endpoints are closed over HTTP, so members are never
  sent pending invitations.
- Better Auth's admin plugin endpoints (`/admin/*`: ban, impersonate, set a
  password, list or remove any user) are closed over HTTP in every mode: the
  gateway's admin pages go through its own server functions, which act only
  on members of the caller's organization and follow the platform policy.
- The OAuth authorization server for MCP clients is on unless
  `MCP_OAUTH_ENABLED` is `"false"`, the kill switch: then its endpoints and
  discovery documents return 404 and only personal access tokens (`epat_`)
  authenticate the gateway's `/mcp`. See `docs/runbooks/mcp-oauth.md` and
  "Connected AI apps (OAuth)" below.
- The AI proxy only forwards inference endpoints (with `store: false` for
  responses and chat completions). The provider key is shared by every app,
  so anything else needs both the operator's allowlist (the
  `AI_PROXY_EXTRA_ROUTES` Gateway setting, e.g. `/v1/files`) and the app
  manifest's `ai.routes`; `ai.models` can restrict models. The upstream
  request carries the gateway's key and none of the app's credentials or
  account selectors (`x-api-key`, `OpenAI-Organization`, `OpenAI-Project`),
  no AI Gateway header (`cf-aig-*`), no `x-everyapp-*` header, no cookie and
  no forwarding headers. OpenRouter (`/api/ai/openrouter`) gets inference
  only: `AI_PROXY_EXTRA_ROUTES` and `ai.routes` never widen it, so its
  account-wide credits and keys endpoints stay closed. Workers AI
  (`/api/ai/workers-ai`) runs in the gateway's own account with its
  `WORKERS_AI_API_TOKEN`, joined under `/client/v4/accounts/<id>/ai` (an
  app path can't leave it), and only its OpenAI-compatible
  `/v1/chat/completions`, `/v1/embeddings` and `/v1/responses` are open:
  the native `/run/<model>`, fine-tunes and the rest of Cloudflare's API
  stay closed, and dispatched Workers can't reach `api.cloudflare.com`
  directly. The proxy's own refusals carry `x-everyapp-error` and
  OpenAI's error body; the provider's errors pass through without it.
- The capability proxy (`/api/integrations/<id>/<host>/<path>` on the
  AppGateway binding, `docs/capabilities.md`) puts a key the gateway holds
  on calls only for an app whose registry row's manifest lists the
  capability, only to that provider's own https hosts, with no redirect
  followed, and only with the methods the provider reads with. The key is
  shared by every app in every organization, so paths that list or describe
  the whole provider account (DataForSEO's `tasks_ready`, `id_list`,
  `errors`, `appendix/user_data`, `appendix/webhook_resend`) are refused.
  The upstream request carries none of the app's `Authorization`,
  `x-api-key`, cookies, `x-everyapp-*` or forwarding headers, and the
  response none of the provider's cookies. Only an app that lists a
  capability learns whether the gateway holds its key. An organization's
  own app's call is attributed to the person whose identity token the app
  forwards when it verifies for the app's organization, otherwise to the
  app; a shared app's calls follow the attribution rule under
  "Organizations and Shared Apps".
- Social networks' OAuth clients (`oauth_client` capabilities,
  `server/capabilities/oauthClient.ts`) are the operator's, one per network
  for every organization. The gateway completes only each network's token
  endpoints (host, exact path, method) for an app whose manifest lists the
  network with `write`, refuses agents' identities outright
  (`integration_agent_not_allowed`, `mcp:write` or not: an agent can't
  connect accounts or mint tokens), removes any client id, secret or
  `Authorization` the app sent (query, body, header, in any case) before it
  puts its own where the endpoint takes it, buffers the body (64 KiB, form
  or JSON only), follows no redirect and drops the network's `set-cookie`.
  The client secret never reaches an app; the public `clientId` reaches only
  an app that lists the network. Logs name the grant type from a known
  list, never the query, body or answer, which carry codes and tokens. The
  access and refresh tokens the exchange returns are the app's, stored and
  used by the app (Postiz encrypts them at rest with its own `JWT_SECRET`).
  X stays an app secret: OAuth 1.0a signs every call with the user's token
  secret, which the gateway never holds.

## Sign-in with Cloudflare Access

Optional (`docs/runbooks/cloudflare-access.md`), and only on a self-hosted
gateway: elsewhere the plugin is not registered and the Access settings are
ignored (passwords alone, no outer ring). Better Auth stays the only
session system: Cloudflare Access, as an OIDC provider or as an outer ring in
front of the gateway's hostnames, only proves who someone is, and a Better
Auth plugin (`apps/every-app-gateway/src/auth/cloudflare-access/`) turns that
into an ordinary Better Auth session. Everything downstream is unchanged.

- Settings are Worker secrets only, never the admin UI.
- The outer ring's `Cf-Access-Jwt-Assertion` (or `CF_Authorization` cookie)
  is never trusted as such: it must be an RS256 JWT signed by a key in the
  team's JWKS (cached ten minutes, refetched for an unknown key id at most
  every 30 s, never used past its lifetime: a fetch failure signs nobody
  in; nobody waits on a fetch for more than 5 s, so one stuck in a cancelled
  request can't hold up the isolate), with the configured issuer and AUD,
  an expiry (60 s of skew), `type: "app"` and an email (service tokens have
  none).
- It signs people in only on the gateway's own host, and only with the
  gateway application's AUD (`CLOUDFLARE_ACCESS_AUD`); the apps' separate
  application (`CLOUDFLARE_ACCESS_APPS_AUD`) only vouches for sessions, so an
  app host's Access cookie is never a gateway login. The runbook asks for
  HttpOnly and the binding cookie on both.
- Behind the outer ring a session cookie counts only with a verified
  assertion for the same person on that request (the header, or the
  `CF_Authorization` cookie browsers also send on bypassed paths): in the
  perimeter on app hosts, server functions, the OAuth pages and Better Auth's
  own endpoints (whose requests have such a session taken out). Sessions are
  only made for that person (a password or OIDC sign-in as anyone else is
  refused). So a person taken out of the Access policy loses browser access
  when their Access session ends. Access bypasses only machine endpoints
  (`/mcp*`, `/oauth/token`, `/oauth/register`, `/.well-known/*`, apps'
  public routes), never `/oauth/authorize` or
  the consent pages. Bearer credentials (personal access and OAuth tokens)
  never pass through Access: offboarding is deactivation. The CLI never
  calls the gateway, so nothing is bypassed for it.
- OIDC sign-in goes through Better Auth's own state and PKCE (S256) with the
  client secret; the ID token is verified in full (signature by the
  application's JWKS, issuer, audience = client id, expiry); posted ID tokens
  are not accepted as a sign-in; only the ID token is stored.
- Nothing plants OAuth state in a browser but a sign-in that browser
  started: Better Auth Expo's `/expo-authorization-proxy` (which set the
  state cookie to any state it was handed, a login CSRF, and redirected
  anywhere) is in `disabledPaths`. The mobile app signs in through a
  handoff instead: the gateway starts the sign-in in the system browser
  from a one-time link, and the callback sends that browser back to
  `everyapp://` with a one-time code (two minutes) instead of a session;
  the app trades the code plus a secret it got on its own request (never in
  the browser) for the session. A link another site led to, or opened on
  another network than the app's request, asks before starting.
- Both identify people by the verified email. Linking to an existing account
  follows Better Auth 1.7's rules: the provider is trusted and its email
  verified, and the existing account's own email must be verified (or the
  link is made while signed in to it), so an account registered with
  someone else's address is never handed over.
- Membership stays the gateway's: members (never deactivated ones), pending
  invitations for the verified email (accepted), operator-listed auto-join
  domains (members with the apps available to everyone, as an invitation
  gives), and through the outer ring only, anyone Access admits if the
  operator opts in. Nothing happens before the gateway is claimed. Removing
  someone from the Access policy is not offboarding (tokens and AI
  connections don't pass through Access): deactivation is, and for people
  auto-join covers, "Delete" deactivates instead, since a deleted account
  would just join again.
- The perimeter strips every inbound `cf-access-*` header (and, as always,
  the cookie header), so apps only ever see the identity JWT.
- `EMAIL_PASSWORD_SIGN_IN=false` closes password sign-in, sign-up and resets
  over HTTP only while Access sign-in is configured and an owner can sign in
  with it; setting it back to `true` reopens them.

## Agent Tools (MCP)

- Two endpoints serve the same tools: the gateway's own `/mcp`, one
  connector for every app a user reaches (tools named `<app>_<tool>`, plus
  the read-only built-ins `everyapp_whoami` and `everyapp_list_apps`), and
  each app host's `/mcp`, for that app alone under its tools' own names.
  Both are served by the gateway's ToolBus from the tool catalogs it
  snapshots in D1 when an app is activated, when a hosted deploy goes live,
  when the app's host sees it run a new version, when the consent page
  shows an app without one, and within a `/mcp` request that finds none
  (apps declare them with `defineTools()`).
  Listing tools serves those snapshots; the gateway calls an app only to
  take one it lacks (at most 20 apps within a request, for 3 s, with the
  one-minute system token that opens nothing but the catalog). Each tool
  call is one call over the app's service binding.
- The gateway's `/mcp` takes an OAuth access token issued by the gateway
  (see below) or a personal access token, never a cookie; a self-hosted
  gateway behind Cloudflare Access's Managed OAuth also takes a verified
  Access assertion for the person (`docs/runbooks/cloudflare-access.md`).
  It serves the active apps of the caller's organization they have access
  to, narrowed to the apps an OAuth connection chose or the one app a token
  is bound to. A browser may call it only from the gateway's own origin or
  an origin listed in `MCP_ALLOWED_ORIGINS` (empty by default); behind
  Managed OAuth, where Access vouches for a browser's cookie too, that rule
  is checked before anything is read for the person.
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
  Only a POST makes the gateway call the app (to sync a missing or
  outdated catalog), so the GETs a sibling page can send with the cookie
  never do.
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
  seconds (headers and body) to answer a call. The compiled checks are
  cached per registry row (never per app id, which two organizations' rows
  share) and catalog hash, and reused only for the exact schema they were
  built from, since the hash is the app's own claim.
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
  http, and neither a client id nor a redirect URI may be on the
  platform's domains (the gateway's host, `APP_BASE_DOMAIN`, or any host
  under either: every host the gateway answers): the authorization
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
  as a "verified" client. That is why client ids on the platform's
  domains are refused, not fetched. A dynamic registration that names no
  token endpoint authentication method is registered as a public client.
- Dynamic registration is anonymous, and each one is a write to the
  account's KV, whose writes every namespace shares. So it keeps only what
  the gateway uses (at most 16 KiB in, the name cleaned and clipped, ten
  redirect URIs), for 60 days without use, and is limited to 5 a minute
  per client address in each isolate, 20 a day per address and 200 a day
  per gateway when self-hosted, 200 and 20,000 on the hosted gateway, none
  when the mode is invalid (counted in D1, where a refused request writes
  nothing).
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
  the same client again in the same organization replaces the earlier
  connection there and its grant (for a metadata document client, the same
  installation's: same redirect URI, a loopback redirect's port not
  counting); a member of two organizations keeps one connection in each.
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
- **The audience is the Worker name.** Every token the gateway mints for an
  app (user identities and public markers in the perimeter, ToolBus call
  identities and catalog system tokens) carries `aud` = the registry row's
  `worker_name` (`every-<orgKey>-<appId>`), never the app id. A deployed
  app expects exactly that: `everyAppWorker()` declares `EVERYAPP_AUDIENCE`
  as the Worker's name (a placeholder the deploy installs as the registry's
  name), the CLI refuses an installed build whose `EVERYAPP_AUDIENCE` is
  anything else, and the SDK answers 500 when it is
  unset. So a token minted for one organization's copy of an app is refused
  by another organization's copy of the same app id. The AppGateway
  entrypoint verifies a forwarded identity against the calling Worker's
  name (its upload-time `workerName` prop) too.
- Only under the dev opt-in (`EVERYAPP_DEV`, which only `everyapp dev`
  sets) does the SDK accept the app id as the audience when
  `EVERYAPP_AUDIENCE` is unset: the dev gateway and dev ToolBus mint for
  the app id, signed with the public dev key, from the dev issuer alone.
- Caches of minted tokens and compiled tool schemas are keyed by audience
  or registry row id, never by app id alone.
- User identity is organization-bound: `org_id` is the organization the
  request acts under, and the person is a live member of it. For an
  organization's own app that is the app's organization (a session acting
  under another of the person's organizations is let in only as their
  membership there); for a shared app it is the session's organization.
  Anything else is denied (see "Organizations and Shared Apps").
- Missing, invalid, expired, or wrong-audience identity fails closed.

## Dispatch Tier and Egress

The hosted gateway reaches third-party apps (registry `tier = 'dispatch'`)
in a Workers for Platforms dispatch namespace. Third-party deploys are off
unless a hosted gateway's `THIRD_PARTY_DEPLOYS` secret is exactly `on`
(`platformPolicy.thirdPartyDeploys`, "Hosted Deploy API" below), and the
gateway's release config declares no namespace yet: the hosted install adds the `DISPATCHER`
binding once the account has one. Until then every dispatch app answers 503.

- `getAppFetcher` is the only code that invokes an app. For a dispatch app
  it reads the optional `DISPATCHER` binding and throws
  `AppUnreachableError` (503 `app_unreachable`, never another route) when
  it is absent; re-checks that the row's Worker name has the registry's
  shape for the app id (`every-<orgKey>-<appId>`, not a gateway name), so
  the registry can never dispatch to a script outside that naming rule
  (the org key is read from the name; checking it against the row's
  organization is to come before third-party deploys open); and calls
  `DISPATCHER.get(workerName, {}, { limits, outbound })`
  with per-invocation limits (by default 5,000 ms of CPU and 200
  subrequests) and the outbound parameter `everyapp` = the app id,
  organization, Worker name and egress allowlist. A script the namespace
  doesn't hold ("Worker not found") is a 503, not an app error.
  Self-hosted apps keep `tier = 'service_binding'` and are reached exactly
  as before; neither tier ever falls back to the other.
- The gateway's `Outbound` entrypoint (`apps/every-app-gateway/src/server/outbound.ts`,
  exported from `server.ts`, no routes) is the namespace's outbound
  Worker: every `fetch()` a dispatched Worker makes to the internet goes
  through it. It denies by default: a request goes out only over HTTPS to
  an exact hostname on the app's allowlist (empty until the manifest
  declares one, so today everything is denied). It always denies the
  providers whose keys the gateway holds (`api.openai.com`,
  `openrouter.ai`, `api.dataforseo.com`, `api.context.dev`,
  `gateway.ai.cloudflare.com`, `api.cloudflare.com` for Workers AI and the
  rest of Cloudflare's API, and their subdomains: `reserved_host`), the
  token endpoints of the OAuth clients the gateway holds, however the path
  is spelled, though not those networks' API hosts, which apps call with
  their users' tokens (`reserved_endpoint`; Mastodon's on `MASTODON_URL`),
  and the gateway's own
  hosts (`GATEWAY_URL`'s host, `APP_BASE_DOMAIN` and every app host under
  it), every third-party app host (`THIRD_PARTY_DOMAIN` and every name
  under it, as set), and refuses everything when the dispatcher passed no
  app. Each
  denial is a 403 to the app and an `egress.denied` log line naming the
  app, organization, Worker, host and reason. Service bindings (the
  AppGateway binding included) never pass through it, so apps reach models
  and data providers only through the gateway's metered proxies.

## Third-Party Hosts and Per-Host Sessions

Two classes of app host, decided from the Host header before any registry
lookup or credential read (`routeHost`,
`packages/perimeter/src/hostRoutes.ts`; the profile comes from
`hostProfile` in `apps/every-app-gateway/src/server/app-hosts.ts`):

|                        | First-party hosts                                                                                                  | Third-party hosts                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Names                  | `<appId>.<APP_BASE_DOMAIN>`, `<appId>-<orgKey>.<APP_BASE_DOMAIN>` (every non-gateway host, looked up by full name) | `<appId>-<orgKey>.<THIRD_PARTY_DOMAIN>`, one label below it |
| Rows served            | `tier = 'service_binding'`, `scope` `org` or `shared`                                                              | `tier = 'dispatch'`, `scope = 'org'`                        |
| Code                   | Workers our account (or the self-hoster) deployed                                                                  | customer code in the dispatch namespace                     |
| Browser credential     | the Better Auth cookie, `Domain=<APP_BASE_DOMAIN>`                                                                 | `__Host-everyapp_s`, host-only, one per host                |
| Personal access tokens | yes                                                                                                                | yes, same rules (own organization, bound app)               |

- **The class decides the row.** A first-party host never serves a
  dispatch row and a third-party host never serves a service-binding or
  shared row (`hostAdmitsApp`): such a row answers 503 `app_unavailable`,
  so a request carrying the shared session never reaches customer code,
  and a per-host session never opens a first-party app. Under the
  third-party domain, a host that is not one app label (the apex, deeper
  names) or has no row is a 404 without falling back to anything.
- **The cookie boundary.** `THIRD_PARTY_DOMAIN` must be another registrable
  domain than the gateway's (`everyapp.dev` beside `app.everyapp.com`):
  `thirdPartyDomain(env)` refuses one whose last two labels equal those of
  `GATEWAY_URL`'s host or `APP_BASE_DOMAIN` (with no public suffix list
  that is the sound test: names that differ there are different sites;
  ones that share them might not be, so they are refused), and is null
  on a self-hosted or invalid-mode gateway whatever the setting says.
  Refused or unset, there are no third-party hosts, the handoff routes
  don't exist, and the deploy API names no hostname. So the browser never
  sends the Better Auth cookie to a third-party host, and the cookie's
  `SameSite` protection holds between customer code and the control plane.
  The third-party authenticator
  (`apps/every-app-gateway/src/perimeter/hostSessionAuthenticator.ts`)
  never reads the Better Auth cookie either, and the first-party one never
  reads `__Host-everyapp_s`; the control plane reads only its own cookie.
- **The handoff** (`apps/every-app-gateway/src/server/host-session.ts`):
  1. An unauthenticated page navigation on a third-party host gets a random
     32-byte nonce in `__Host-everyapp_n` (host-only, `Secure`, `HttpOnly`,
     `SameSite=Lax`, 10 minutes; reused while present, so tabs share it) and
     a 302 to `<gateway>/app-session?return_to=<page>&nonce_hash=<SHA-256>`.
     Other unauthenticated requests get 401 as on first-party hosts.
  2. `GET /app-session` on the control plane sends a signed-out browser to
     sign in and back; signed in, it answers a page that posts the handoff
     to `POST /app-session/start` from the gateway's own origin (the
     control-plane guard refuses a cross-site POST that carries the
     cookie; the page's CSP allows only its own script and a form action to
     the gateway and the app's origin).
  3. `POST /app-session/start` re-checks that `return_to` is https on a
     third-party host, that the host's registry row is a dispatch app that
     isn't disabled, and that the signed-in person is a member (not
     deactivated) of its active organization with the app installed for
     them; otherwise 400, 404 or 403 and no code. It answers 303 to
     `https://<host>/__everyapp/session?code=…`: a MAC token (HMAC-SHA256,
     key from `BETTER_AUTH_SECRET` through HKDF under its own label) naming
     the gateway session id, the user, the app row, the host, the nonce
     hash and the page, valid 60 seconds, with a single-use id.
  4. The app host's perimeter answers `/__everyapp/session` itself (never
     the app): the code must verify, be a code (never a session token), be
     unexpired, name this host and this app row, and match the hash of the
     browser's nonce cookie, so nobody can sign a victim in to the
     attacker's account by sending a code; then its id is claimed once in
     D1 (`rate_limit_counters`, an insert that only one request wins). It
     sets `__Host-everyapp_s` (a MAC token bound to the gateway session id,
     user, app row and host, 24 hours), clears the nonce and 303s to the
     page path. Anything else is a 400 page with no cookie. Both answer
     `Referrer-Policy: no-referrer`, so neither the redirect nor the 400
     page's link back to the app sends the app the code's URL as `Referer`.
- **Every request re-checks.** `__Host-everyapp_s` is verified (signature,
  type, expiry, host, app row), then, live: the gateway session row still
  exists and hasn't expired, the user isn't deactivated, they are a member
  of the app's organization (the identity JWT carries that organization
  and their role there, `aud` the Worker name), the organization is active
  and the app is installed for them. Signing out of the gateway, an admin
  revoking sessions, removing the member or their access ends the host
  session on the next request (memberships and organization status are
  cached per isolate up to 30 seconds, as on first-party hosts; the
  session row is read every time). A request naming `__Host-everyapp_s`
  twice is refused (`duplicate_session_cookie`). A bearer that isn't a
  personal access token authenticates nobody here and never falls back to
  the cookie.
- **What an app may not say.** On third-party hosts the perimeter removes
  `Access-Control-Allow-Credentials` from app responses (sibling apps on
  the same domain are same-site, so a credentialed CORS grant would let one
  read another's pages with the visitor's session) and every `Set-Cookie`
  whose name starts with `__Host-everyapp_` in any case (only the
  perimeter sets the session and nonce), WebSocket handshakes (101)
  included. `Domain` is stripped from app cookies everywhere, so they stay
  host-only (on third-party hosts, from 101s too). State-changing requests must
  be same-origin (`Sec-Fetch-Site: same-origin` or a matching `Origin`), so
  a sibling app's page can't post with the visitor's session.
- **Self-hosted gateways** have no third-party domain: every host but the
  gateway's own is first-party and looked up as before, the handoff paths
  are the control plane's and the app's as before, and only a dispatch row
  (which no self-hosted deploy writes) is refused.
- Third-party hosts reach the gateway Worker through a Workers route
  `*.<THIRD_PARTY_DOMAIN>/*` on that zone, added by hand on the hosted
  install (`docs/runbooks/hosted-install.md`), never a Custom Domain per app.

## Hosted Deploy API

Third-party apps (customer code, forks of OpenSEO included) reach the
hosted gateway's dispatch namespace only through its deploy pipeline
(`apps/every-app-gateway/src/server/deploy/`): the deploy API, which
`everyapp deploy --gateway <url>` with `EVERYAPP_DEPLOY_TOKEN` calls, and
an admin's install from GitHub.

- **The launch gate.** The routes (`/api/v1/…` on the gateway's host)
  exist only while `platformPolicy(env).thirdPartyDeploys` holds: a hosted
  gateway whose `THIRD_PARTY_DEPLOYS` secret is exactly `on`. Otherwise
  the paths are the control plane's like any other (404), and no deploy
  key can be made. The CLI never sets the gate; it is opened by hand, and
  stays shut until the isolation set (limits and the `Outbound`
  default-deny on every dispatch, this allowlist and its read-back),
  identities minted for the Worker's name (`aud = workerName`), per-host
  sessions on the separate third-party domain and the egress default-deny
  are verified against a live namespace.
- **Deploy keys.** A personal access token with the `deploy` scope and
  nothing else (`*` doesn't count), bound to one organization and
  optionally one app, 30 days by default. Every request checks it live
  (its scopes included: a row holding any scope beside `deploy` is refused
  where it is used, not only where keys are made):
  unknown, revoked or expired is a 401; its owner must still be a member
  (not deactivated) and an owner or admin of that organization, which must
  not be suspended; a path naming another organization is a 404, and an
  app-bound key deploys only its app. The API reads no cookie. A deploy
  key opens no app on the perimeter and no `/mcp` connection.
- **The deployer rewrites, or refuses.** Every app build is tenant-neutral
  (`BUILD_SENTINEL` in `@every-app/sdk/cloudflare/sentinel`) and the CLI
  uploads it uninstalled, so the bundle's bindings are placeholders. The deployer builds the upload's bindings from the
  manifest and the registry row only: the app id, the audience (the
  registry's Worker name), the gateway's identity key and issuer, the
  organization and `GATEWAY_URL` as plain text; the `EVERY_APP_GATEWAY`
  service binding to the gateway's `AppGateway` with the props
  `{organizationId, appId, workerName}`; the D1 databases it created (the
  CLI's resource ledger records them as the app's, with the CLI's rules: a
  name recorded for another app, or a database with the name that no
  deploy of the app created, is refused; a name claimed by a deploy that
  stopped before recording the id is finished by the next one); its own Durable Object classes (new ones get
  the next `everyapp-v<n>` migration, a dropped one is refused); its
  assets; version metadata. Every refusal (the policy below, a dropped
  class, a migration tag the deployer didn't write) comes before any
  database is created or migrated: the app's D1 migrations run only once
  the upload's metadata is built, right before the upload, as in the
  self-host deploy. A bundle declaring anything else is refused
  before anything is registered or created: service bindings to any other
  Worker, dispatch namespaces, another Worker's Durable Objects, KV, R2,
  Hyperdrive, rate limits, the secrets store, mTLS, Workers AI, email,
  queues, other secrets or variables, unknown types; crons, routes,
  domains, tail consumers, logpush, placement or limits of its own;
  Workflows, helper Workers, dev mode, unlisted compatibility flags, more
  Durable Object classes than the policy allows (2). The script gets the
  policy's limits (5,000 ms CPU, 200 subrequests), the tags `org-<id>`,
  `app-<id>` and `kind-org`, and observability on.
- **Read-back.** After the upload the deployer reads the Worker's bindings
  back from Cloudflare and compares them with what it sent: the same
  names, once each, every field it sent unchanged (the type, ids, props),
  and a Durable Object binding's Worker, when listed, the app's own.
  Fields Cloudflare adds (a service binding's `environment`, a Durable
  Object binding's `namespace_id`) don't count. On any difference it
  deletes the Worker and fails the job, so a Worker whose bindings the
  deployer didn't choose never serves.
- **Registry.** Rows are `tier = 'dispatch'`, `scope = 'org'`, the Worker
  `every-<orgKey>-<appId>` (the only name `getAppFetcher` dispatches to),
  the hostname `<appId>-<orgKey>.<THIRD_PARTY_DOMAIN>` (none while the
  domain is unset, or treated as unset for sharing a site with the
  gateway: nobody can open the app; see "Third-Party Hosts and Per-Host
  Sessions"). A `THIRD_PARTY_DOMAIN` that is `APP_BASE_DOMAIN`, or under
  or above it, refuses every registration and deploy
  (`DEPLOYER_NOT_CONFIGURED`). An app keeps its tier: the
  CLI's self-host deploy refuses a dispatch row and the deploy API a
  service-binding one (`APP_TIER_MISMATCH`); a shared app is never a
  dispatch app. Each deploy is a `deploy_jobs` row, one running at a time
  per app, started before the deploy touches the row (one refused as
  `DEPLOY_IN_PROGRESS` changes nothing); `deployed_by_actor` is
  `deploy-key:<token id>` (an install from GitHub: the admin's email).
- **Install from GitHub.** An owner or admin (the role read live, as a
  deploy key's is; the organization not suspended) can also deploy from
  Admin → Apps: `POST /api/admin/apps/install` with a session, a
  control-plane route behind its CSRF guard, behind the same launch gate
  (`APP_INSTALL_NOT_AVAILABLE` otherwise, and on every self-hosted
  gateway). The gateway downloads `https://github.com/<owner>/<repo>/releases/latest/download/everyapp-release.tar.gz`
  with no credentials (https redirects only, 100 MB compressed and again
  unpacked), reads the tar itself (regular files and directories only: a
  link, a device, an absolute or `..` path, a bad header checksum or a
  file listed twice refuses the archive; nothing but `release.json`,
  `.cloudflare` and `migrations` at the top), checks every file against
  `release.json`'s `sha256` and refuses helper Workers in the Build
  Output. The release is untrusted as an upload is: its bundle meets the
  same policy, rewrite and read-back, refused before the app is
  registered. The sha256 proves the archive is whole, not who built it:
  whoever can publish a release on the repository chooses the code, so
  an admin installs a repository they trust. `deployed_by_actor` is the
  admin's email, and the job records the repository, tag, version and
  commit it came from (`deploy_jobs.source`).
- **The CLI.** Only `EVERYAPP_DEPLOY_TOKEN` sends `everyapp deploy` to the
  deploy API; `EVERYAPP_TOKEN` (a self-hoster's MCP bearer) and
  `EVERYAPP_GATEWAY_URL` alone leave the self-host deploy as it was.
- The Cloudflare token (`CF_DEPLOY_TOKEN`, Workers for Platforms and D1
  edit) is a secret of the hosted gateway: whoever reads the gateway's
  secrets can deploy into the namespace. The hosted gateway is ours alone.

## Response Contract

- The gateway removes `Domain` from app `Set-Cookie` headers so apps cannot set
  parent-domain cookies.
- HTML responses receive the perimeter CSP floor (`frame-ancestors 'none'`,
  `base-uri 'self'`, `object-src 'none'`) without a blanket `default-src`.
  An app may keep `frame-ancestors 'self'` (then `X-Frame-Options` is
  `SAMEORIGIN`), since every app has its own origin and that admits neither
  the gateway nor another app, and may keep `base-uri 'none'`; any other
  value of those three is replaced by the floor.
- HSTS, `nosniff`, frame denial, and referrer policy are applied uniformly.
- Structured gateway events (`logEvent`: setup claims, invitations, member
  changes, app activations, AI usage and upstream failures, proxied
  requests, unhandled server-function errors) go through a logger that
  redacts `cookie`, `authorization`, `set-cookie` and any token, secret,
  password or code field. Other error logs (perimeter and app failures)
  record an error's message and stack as thrown, so errors must not put
  credentials in their messages.
- Deploys happen outside the gateway, so it logs none: who uploaded an
  app's live version is on its row (`deployed_by_actor`, `deployed_at`,
  `version_id`), the Cloudflare login's email or `api-token:<account id>`.
