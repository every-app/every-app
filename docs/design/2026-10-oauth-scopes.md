# Per-app OAuth scopes, enforced at the gateway: design

Written 2026-10-23 for the launch. Ben's question: the operator's Google
OAuth client can reach Gmail, Calendar, Search Console and Analytics; is it
all or nothing per app, and can the gateway limit each app to the scopes it
needs and enforce that itself? Section 1 is the state of `main` at
`bc3fe476` (line numbers are of that commit); the rest is the design and
what was built. The threat model cites this document; the secrets thread
owns required/optional/one-of settings and the teams thread per-member
permissions, neither of which this changes.

## 1. How OAuth works today

**Who holds what.** The gateway holds one OAuth client per provider as
Worker secrets, registered in `packages/sdk/src/internal/capabilities.ts`
(`CAPABILITIES`, mode `oauth_client`): the 16 social networks Postiz uses,
and since #346 (2026-10-19) `google-workspace`
(`GOOGLE_WORKSPACE_CLIENT_ID`/`_SECRET`, lines 722-752) and `microsoft-365`
(`MICROSOFT_365_CLIENT_ID`/`_SECRET`, lines 753-780), added for Open CRM's
mail and calendar reading, next to `slack` (lines 548-600, Postiz's and
Open CRM's scopes). `youtube` (lines 356-397) is a second Google client,
Postiz's, completing the same `oauth2.googleapis.com/token` endpoint. Each
entry names the token endpoints the gateway completes (`token`: host,
exact path, methods, where the client is injected), the authorize URL and
scopes (`authorize`), the API hosts (`api`) and the redirect paths the
operator registers (`redirectPaths`). `authorize.scopes` and `api` are
documentation: the operator's checklist in `docs/capabilities.md` (the
tables between the `oauth-clients` markers are generated from the registry
by `capabilitiesDoc.test.ts`). Nothing in the gateway reads them. No
organization-held accounts exist: the Google design
([docs/design/2026-10-google-integration.md](https://github.com/every-app/private-every-app/blob/5ef30882/docs/design/2026-10-google-integration.md),
deleted from main on 2026-10-24 by the simplify work, #433; readable at
commit `5ef30882`, its rulings kept in [docs/hosted-vision.md](../hosted-vision.md)) describes
`integration_accounts`, grants and a token broker, and none of it is built
(the grants table was deferred, TODO.md "Google: the operator holds the
OAuth client").

**How an app connects an account.** The app lists the client for writing,
`capabilities: { "google-workspace": { access: "write", why } }`
(`packages/perimeter/src/manifest/manifest.ts:227-255`: an entry is
`{ access, why }` and nothing else; the strict validator refuses unknown
keys). At deploy the manifest is snapshotted into the app's registry row
(`apps.manifest`, `src/db/apps.schema.ts:45`), which is the grant. The app
asks the gateway for the client's public id
(`GET /api/integrations/<id>` over the binding, `integrationStatus()`,
answered by `oauthClientStatus`,
`apps/every-app-gateway/src/server/capabilities/oauthClient.ts:44-70`:
`{ capability, requested, configured, ready, clientId?, origin? }`), builds
the authorize URL itself, with whatever `scope` it chooses, and sends the
person to the provider. The provider redirects to the app's own host
(`/integrations/google/callback`, `/integrations/microsoft/callback`,
Postiz's `/integrations/social/<network>`). The app posts the code to
`/api/integrations/<id>/<token host><token path>` through
`integrationFetch()`; the gateway puts the client on the request and
streams the provider's answer back to the app, which stores the access and
refresh tokens and calls the provider's API with them directly. Refreshes
go the same way. "The gateway completes the network's token endpoints
only" is the contract `docs/capabilities.md` ("OAuth clients") and
`packages/sdk/README.md` ("Social networks' OAuth clients") give app
authors, with "call the network's API with the user's token directly".

**What the consent asks for.** Whatever the app put in `scope`. The
registry lists, as the operator's checklist, `gmail.readonly` and
`calendar.readonly` for `google-workspace`, `offline_access User.Read
Mail.Read` for `microsoft-365`, and 20 bot and user scopes for `slack`; the
provider's console is where the operator allows scopes on the client, and
Google's consent screen configuration is the only place a scope an app
asks for can be refused. The app may ask for any scope the client is
allowed, and with Google's `include_granted_scopes=true` the token it gets
carries every scope the same person ever granted this client, through any
app.

**Where tokens live.** In the app: its own D1 or Durable Object, encrypted
or not as the app decides (Postiz: its integrations table; OpenSEO, still
on its own client: `gsc_connections` and `ga4_connections`, sealed with its auth secret). The
gateway never stores a user token. Its logs record the call
(`integration.proxy.call`: organization, app, Worker, host, path, method,
`grant_type`, status, attribution), never the body or the answer
(`oauthClient.ts:171-198`).

**How a token call is authorized.** The AppGateway entrypoint
(`src/server/app-gateway-entrypoint.ts:101-160`) proves the caller is a
registered, active app: the service binding's upload-time props
(organization, app id, Worker name) must match a registry row. Then
`handleOAuthClientCall` (`oauthClient.ts:72-210`) checks, in order, each a
refusal with its code in `x-everyapp-error`: (1) the call is one of the
client's token endpoints, host and exact path and method
(`integration_path_not_allowed`: "Call its API with the user's token
directly"); (2) the deployed manifest lists the client with
`access: "write"` (`capability_not_requested`); (3) `admit()`
(`app-gateway-entrypoint.ts:168-186`, `attributeCall` at 356-434): an
organization's own app is attributed to its organization from the props,
with the forwarded identity naming the person when it verifies; a shared
app's call must carry a verified identity, or for background work
`x-everyapp-org` naming an active organization with a live member; an
agent's identity (`chan: "mcp"`) is refused
(`integration_agent_not_allowed`); (4) the gateway holds the client
(`integration_not_configured`); (5) the body is at most 64 KiB, form or
JSON, and the app's own `client_id`/`client_secret` are stripped wherever
they were before the gateway's are put on (`injectClientCredentials`,
`packages/sdk/src/internal/oauthClient.ts:73-170`). The `grant_type` is
read for the log only (`tokenGrantType`, lines 184-196); `client_credentials`
with the operator's client is completed like any other. The provider's
response passes through untouched except for `set-cookie`.

**How a proxied API call is authorized, for comparison.** The API-key
capabilities (`dataforseo`, `context`) are proxied:
`/api/integrations/<id>/<host>/<path>` (`integration-proxy.ts:161-262`)
checks the host is the provider's, the path isn't account-wide
(`isAccountWidePath`), the method is one the app's `access: "read"` allows
(`readMethods`), the key is held, then `admit()` as above, and forwards
with the gateway's key. That is the shape the AI proxy uses too
(`ai-proxy.ts`: per-provider `inferenceRoutes`, `extraRoutes`). No OAuth
client has such a path: API calls never reach the gateway.

**So what stops an app granted `google-workspace` from reading Gmail when
it only needs Search Console?** Nothing on the gateway. The manifest entry
says "write" and "why" and nothing about scopes; the authorize URL and its
`scope` are the app's; the gateway completes the exchange without reading
the request's or the response's scopes; the token then lives in the app,
which calls Google directly. The only bounds are at Google: which APIs the
operator enabled on the Cloud project, and which scopes the consent screen
is configured for, both shared by every app and every organization on the
gateway. The two Google clients (`google-workspace` and Postiz's
`youtube`) can even be the same Cloud project, in which case one person's
grants to Postiz and to Open CRM are one authorization at Google. An app
that declares the client can mint a token for any scope the client is
allowed, keep it, and use it in the background forever; the admin pages
show nothing about it (Admin → Apps shows the app's installation email
facts only, `AppsTable.tsx:40-85`), and the deploy that added the
capability asked nobody.

**What the gateway does control.** The client secret, so no token can be
minted or refreshed except through the gateway: the token endpoint is a
mandatory choke point, and the one place a per-app boundary can be
enforced without the gateway holding tokens. It also knows, for every
token call, which app and organization made it and whether a person was
behind it. It does not see API calls, and will not until it holds the
tokens (the Google design's organization-held accounts), which is the
boundary that design's invariant 4 calls "gateway-enforced per-app
narrowing" and which remains unbuilt.

## 2. The boundary this design makes real

After this design, **an app can only ever receive tokens whose granted
scopes are within the scope sets its deployed manifest declares**, enforced
by the gateway at every token mint and refresh (the only place every token
passes) by reading the provider's granted `scope` and refusing to forward
a response that exceeds the grant. Nothing an app does on the authorize URL
gets it a wider token through the gateway, because the exchange is where
the token materialises. The manifest declares named scope sets; the
registry maps each set to the provider's scope strings and to the API
hosts and paths it unlocks; the gateway checks the token request and the
token response against the declared sets; the status hands the app the
exact scopes to put on the authorize URL; Admin → Apps shows what each app
declared and why.

**The host+path allowlist is built and tested but is not a live boundary
yet**: no OAuth API call passes through the gateway. It becomes live for
dispatch-tier apps when the outbound Worker enforces it (the first gateway
PR after launch) and for every app when the gateway holds the tokens
(section 10). Until then the enforced boundary is *which tokens an app can
obtain*, not *what it does with them*, and the provider enforces the
scopes on its API.

| Attacker or case | Boundary after this design | Enforced by | Residual |
| --- | --- | --- | --- |
| A malicious or compromised approved app asks Google for `gmail.readonly` while declaring `search-console.read` | The exchange is refused `integration_scope_exceeded`; the tokens are never forwarded; the refusal is logged with the excess | Step 7 | Tokens the app already holds from before the gateway deploy work until they need a refresh (about an hour on Google and Microsoft). Direct API calls stay unseen until the gateway holds tokens. |
| The same app with Google's `include_granted_scopes=true` on a shared Cloud project (Open CRM sends it today) | A token unioned with another app's grants exceeds the sets and is refused | Step 7 | Apps must stop sending the flag; `authorizeUrl()` refuses it. Open CRM must redeploy before a gateway carrying the check serves it. |
| Microsoft: a person consented `Mail.Send` to app B on the shared Entra client; app A, declaring `mail.read`, exchanges or refreshes | The gateway replaces the token-leg `scope` with app A's allowed list and refuses a response whose `scope` exceeds it | Steps 5f and 7 | Entra may issue every consented scope regardless of the request; app A's exchange is then refused: availability loss, not narrowing. The fixes are one registered client per app, or gateway-held tokens with the Graph allowlist. One Microsoft consumer today. |
| Slack: a second app installs into the same workspace with more scopes (installations add up, never shrink) | App A's next exchange gets the union and is refused | Step 7, once Slack has a policy | Same limit; recovery is reinstalling with the status's scopes. |
| A background caller (an organization's app with no identity; a shared app with `x-everyapp-org`) refreshing from a cron | The same check; the grant is the app's, not the person's | Step 7; the entrypoint's attribution is unchanged | None beyond today's attribution rules. |
| A compromised app replaying another app's refresh token on the same client | Refused only if the other app's scopes exceed this app's sets | Step 7 | A refresh token is a bearer credential the gateway cannot bind to an app without holding tokens. |
| An app using `client_credentials` or an exchange grant with the operator's client | Refused `integration_grant_not_allowed` for capabilities with a policy | Step 5d | Postiz's social clients keep today's behaviour (no policy, no new checks). |
| A query string carrying `grant_type` or `scope` that disagrees with the body (`tokenGrantType` falls back to the query) | Refused `integration_body_invalid` for capabilities with a policy | Step 5b | None. |
| A public client (no `clientSecret`) with a scope policy | Not possible: a registry invariant requires a confidential client | Registry test | The mint-time boundary exists only because the client is confidential; a public client would let an app exchange codes directly with the `clientId` the status hands out. |
| One client shared across organizations | The grant is per app and identical for every organization; logs carry organization and app | Entrypoint props | Per-organization narrowing and approval are the Google design's unbuilt grants (and the teams thread). The gateway never revokes at Google, whose `/revoke` is project-wide per person. |

**Rejected for launch: a minimal gateway-held-token mode.** It needs an
`integration_accounts` table and migration, an encryption-key setting,
refresh under lease, a proxy branch, a connect and callback flow on the
gateway (or an app-posted token response), SDK account ids, and Open CRM
changes: three to four agent-days on top of the mint check, and a far
larger gateway PR to review. The mint check is the smallest change that
makes a real boundary for Google and Slack tokens, and it is the first half
of the gateway-held design: the gateway reads and checks the token response
either way.

## 3. Scope sets in the manifest

An app that lists an OAuth client with a scope policy names the sets it
uses, next to `access` and `why`:

```ts
capabilities: {
  "google-workspace": {
    access: "write",
    scopes: ["search-console.read", "analytics.read"],
    why: "Reads Search Console and GA4 for the sites you connect.",
  },
  "microsoft-365": { access: "write", scopes: ["identity", "mail.read"], why: "…" },
},
```

The strict validator (`everyapp deploy` and
`everyapp release`) refuses a capability with a policy that lists no
`scopes`, an empty list, a duplicate, or a name the registry doesn't
define, naming the sets offered
(`capabilities.google-workspace.scopes.1: unknown scope set (Google
(Gmail, Calendar, Search Console and Analytics) offers: identity,
gmail.read, calendar.read, search-console.read, analytics.read)`), and
refuses `scopes` on a capability without a policy (`Mastodon takes no
scopes`). The lenient schema the gateway reads a stored row with keeps the
field as `string[] | undefined` and reads a malformed value as undeclared
(`.catch(undefined)`, the `email.inbound` precedent), so a newer CLI's
manifest never bricks a row on an older gateway: the gateway refuses the
token call instead, with a message that says to update the gateway (`everyapp update`)
if it is the newer one. The hosted deploy API, which runs only the lenient
validator, adds the same two cases to `manifestProblems` so a hand-crafted
bundle is `BUNDLE_REFUSED` before any row is written. Set names are short
and provider-neutral (`<area>.<access>`, plus `identity`), as the Google
design chose (its Appendix B, "Scope short names"); the status maps them to
provider strings, so a manifest never carries a Google URL.

What the live apps declare: Open CRM `google-workspace: ["gmail.read",
"calendar.read"]` (exactly its `REQUESTED_SCOPES.google`) and
`microsoft-365: ["identity", "mail.read"]` (exactly `offline_access
User.Read Mail.Read`); OpenSEO, when it moves onto the gateway's client,
`["identity", "search-console.read", "analytics.read"]` (it keys accounts
by the `id_token`'s `sub`). Write sets (`gmail.send`, `calendar.events`,
`mail.send`) are deliberately not defined: no app asks, the deployed
manifest is a self-declared grant with no approval step yet, and the Google
design's invariant "read-only by construction" holds; adding one is a
reviewed registry change.

## 4. The registry's scope policies

`OAuthClientCapability` gains an optional `scopePolicy`; a client without
one (Postiz's sixteen, `youtube`) behaves exactly as today. The policy is
data, so the docs generator renders it and the dialect enum picks the
parser:

```ts
interface OAuthScopeRoute { host: string; paths: readonly string[]; posts?: readonly RegExp[] }
interface OAuthScopeSet {
  label: string;                 // "Gmail (read-only)", for Admin → Apps
  access: CapabilityAccess;      // read sets unlock GET/HEAD and read-shaped POSTs only
  scopes: readonly string[];     // the provider's strings, requested verbatim
  userScopes?: readonly string[];// Slack's user_scope, later
  routes: readonly OAuthScopeRoute[];
}
interface OAuthScopePolicy {
  sets: Readonly<Record<string, OAuthScopeSet>>;
  tolerated: readonly string[];      // identity and refresh scopes a response may carry; never a data scope
  alwaysRequested: readonly string[];// offline_access on Microsoft
  dialect: "google" | "microsoft" | "slack";
  grantTypes: readonly (string | null)[];     // null: a code exchange with no grant_type (Slack)
  requestScope: "replace" | "drop" | "keep";  // what happens to the token request's scope
  deniedSegments: readonly string[];          // batch tunnels and secrets no set unlocks
}
```

Registry invariants (tested): a policy implies a confidential client;
`authorize.scopes` equals `alwaysRequested ∪ sets[*].scopes ∪
sets[*].userScopes`, so the operator's checklist in `docs/capabilities.md`
cannot drift from what apps may ask; every route host is in `api` and no
set unlocks a token endpoint's path (Slack's API and token endpoint share
`slack.com`); no path contains `//`, `\`, `%`, `batch`, `$batch` or
`/beta/`; `posts` regexes are anchored and flagless; set names match
`identity | <area>.<access>`; no write set on `google-workspace` or
`microsoft-365`.

**`google-workspace`** (one Cloud project reaching Gmail, Calendar, Search
Console and Analytics, Ben's premise; Postiz's `youtube` stays its own
client). Dialect `google`, grants `authorization_code` and
`refresh_token`, request `scope` dropped (Google documents none on either
token leg), tolerated `openid`, `email`, `profile` and the two `userinfo`
URLs Google echoes them as, denied segments `batch` and
`measurementProtocolSecrets`.

| Set | Label | Provider scope | Unlocks (host: paths; read-shaped POSTs) |
| --- | --- | --- | --- |
| `identity` | Google account (who you are) | `openid`, `email`, `profile` | `openidconnect.googleapis.com/v1/userinfo`; `www.googleapis.com/oauth2/v2/userinfo`, `/oauth2/v3/userinfo`, `/userinfo/v2/me` |
| `gmail.read` | Gmail (read-only) | `…/auth/gmail.readonly` | `gmail.googleapis.com/gmail/v1/users/…`; POST only `watch` and `stop` (never `messages/send`, drafts or `modify`) |
| `calendar.read` | Google Calendar (read-only) | `…/auth/calendar.readonly` | `www.googleapis.com/calendar/v3/…`; POST `freeBusy`, event and calendar-list `watch`, `channels/stop` |
| `search-console.read` | Search Console (read-only) | `…/auth/webmasters.readonly` | `www.googleapis.com/webmasters/v3/…` and `searchconsole.googleapis.com/webmasters/v3/…`; POST `sites/<site>/searchAnalytics/query` and `v1/urlInspection/index:inspect` |
| `analytics.read` | Google Analytics (read-only) | `…/auth/analytics.readonly` | `analyticsdata.googleapis.com/v1beta/properties/…` with the report POSTs (`runReport`, `batchRunReports`, `runPivotReport`, `batchRunPivotReports`, `runRealtimeReport`, `checkCompatibility`); `analyticsadmin.googleapis.com` `v1beta` accounts, account summaries and properties, and `v1alpha/properties/…` (GET only: OpenSEO reads key events, data streams and enhanced-measurement settings there); `measurementProtocolSecrets` denied |

**`microsoft-365`**. Dialect `microsoft`, grants `authorization_code` and
`refresh_token`, request `scope` replaced by the app's allowed list on
every token leg (Microsoft's one-resource-per-token rule), `offline_access`
always requested and never echoed, tolerated `openid`, `profile`, `email`,
`offline_access`, `User.Read`, compared case-insensitively after the Graph
prefix is stripped; denied segments `$batch` and `beta`. Only `/v1.0/me/…`
is allowlisted: `/v1.0/users/<id>/…` reaches shared mailboxes under the
same permissions and stays off.

| Set | Label | Provider scope | Unlocks on `graph.microsoft.com` |
| --- | --- | --- | --- |
| `identity` | Microsoft account (who you are) | `User.Read` | `/v1.0/me`, `/oidc/userinfo` |
| `mail.read` | Outlook mail (read-only) | `Mail.Read` | `/v1.0/me/messages…` (ids, attachments, `delta`), `/v1.0/me/mailFolders…` |
| `calendar.read` | Outlook calendar (read-only) | `Calendars.Read` | `/v1.0/me/calendar…`, `/v1.0/me/calendars…`, `/v1.0/me/events…`, `/v1.0/me/calendarView…`; POST `calendar/getSchedule` |

**`slack`** gets a policy later (PR 7, if time): dialect `slack`, grants
`null` (its `oauth.v2.access` carries no `grant_type`) and
`refresh_token`, bot sets `channels.read`, `users.read`, `users.email`,
`messages.write`, `channels.join`, `channels.manage`, `files.write`, and
the user set `user-channels.manage`, routes by method name under
`slack.com/api/`. Postiz's and Open CRM's installations then declare their
sets, and the four scopes nobody asks for leave the checklist. A gateway
carrying it must not go live before both apps redeploy with `scopes`.

## 5. Enforcement at the token endpoint

`handleOAuthClientCall` keeps today's order and adds steps for a capability
with a policy; capabilities without one skip every new step, so the
existing suite passes unchanged. Each refusal goes through
`capabilityRefusal` with its code in `x-everyapp-error`; nothing reaches
the provider before step 6.

| # | Check | Code | Status |
| --- | --- | --- | --- |
| 1 | the token endpoint: host, exact path, method (today) | `integration_path_not_allowed` | 403 |
| 2 | the deployed manifest lists the client for writing (today) | `capability_not_requested` | 403 |
| 2b | the entry's `scopes` is a non-empty list of known set names (missing, empty, malformed, a duplicate or any unknown name voids the whole grant) | `integration_scopes_undeclared` | 403 |
| 3 | `admit()`; an agent's identity is refused (today) | `caller_*`, `integration_agent_not_allowed` | 401/403 |
| 4 | the gateway holds the client (today) | `integration_not_configured` | 503 |
| 5a | the body is at most 64 KiB (today) | `integration_body_too_large` | 413 |
| 5b | the query string carries no `grant_type`, `scope` or `user_scope`: the gateway decides on the body only | `integration_body_invalid` | 400 |
| 5c | `injectClientCredentials` (today; untouched) | `integration_body_invalid` | 400 |
| 5d | the `grant_type` is one of the policy's (`authorization_code`, `refresh_token`; never `client_credentials` or a token exchange: an app never gets app-level tokens with the operator's client) | `integration_grant_not_allowed` | 403 |
| 5e | the request's `scope` (and Slack's `user_scope`), when present, names nothing outside the allowed list | `integration_scope_not_allowed` | 403 |
| 5f | the request's `scope` is rewritten per policy: Microsoft replaced with the status's scopes, Google dropped, Slack kept (not a refusal) | | |
| 6 | the provider is called; failure (today) | `integration_upstream_failed` | 502 |
| 7 | a 2xx answer is read under the same 64 KiB cap: not a JSON object or over the cap refuses; an answer carrying no token (`access_token`, `refresh_token`, `id_token`, `authed_user.access_token`) is forwarded; a token-bearing answer that names no scopes refuses; granted scopes outside the allowed list refuse. On any refusal the body is dropped: the tokens are never forwarded, stored, logged or revoked. On success the buffered answer is forwarded with the provider's status and headers minus `set-cookie` and the length and encoding headers | `integration_response_invalid` 502, `integration_scope_unverified` 502, `integration_scope_exceeded` 403 | |

Non-2xx answers keep streaming through untouched: they carry no token and
a provider's own error must stay recognisable (`gatewayRefusal()` keys on
the header). The response is checked and not only the request because
Google and Slack take no `scope` on the token endpoint: the answer is the
only place the gateway learns what a token holds. Microsoft gets the
request rewritten *and* the answer checked, because Entra may return
consented scopes the request did not name. A **removed scope set** is
caught at the next refresh: the token minted under the wider manifest
echoes its old scopes and is refused `integration_scope_exceeded`; the app
reconnects the person with the narrower list. A missing `scope` field
fails closed: all three providers document it on every success response.
The `integration_scope_exceeded` message names the excess and the declared
sets and ends with the provider's recovery: on Google, ask for only the
status's scopes without `include_granted_scopes` and connect again; on
Microsoft, remove the app's consent at myapplications.microsoft.com and
connect again; on Slack, reinstall the app with the status's scopes; or add
the set to `everyapp.config.ts` and deploy. The 30-second caller cache
delays a manifest change by at most that, as for every capability.

## 6. Status, SDK and local dev

`GET /api/integrations/<id>` for a client with a policy, when the app
lists it, the gateway holds the client and the grant is valid:

```json
{ "capability": "google-workspace", "requested": true, "configured": true, "ready": true,
  "clientId": "…", "scopeSets": ["identity", "search-console.read", "analytics.read"],
  "scopes": ["openid", "email", "profile",
             "https://www.googleapis.com/auth/webmasters.readonly",
             "https://www.googleapis.com/auth/analytics.readonly"] }
```

`scopes` are the exact provider strings to put on the authorize URL, in
registry order (Microsoft's end with `offline_access`; Slack adds
`userScopes`). A void grant (step 2b would refuse) answers `requested:
true, configured: <client held>, ready: false, scopeSets: []` with no
`clientId` and no `scopes`, so the app shows "not available" instead of
starting a flow that cannot complete. Clients without a policy answer
byte-identically to today.

The SDK's `OAuthClientIntegrationStatus` gains the three fields, and a new
`authorizeUrl({ provider, status, redirectUri, state, codeChallenge?,
params? })` builds the provider's authorize URL from the status: the
registry's authorize endpoint (or `status.origin`), `client_id`,
`response_type=code`, the status's `scopes` (Slack: comma-joined, plus
`user_scope`), Google's `access_type=offline`, Microsoft's
`response_mode=query`, S256 when a challenge is given. It throws a
`TypeError` when the status isn't ready, when a policy capability's status
carries no `scopes`, or when `params` names `scope`, `user_scope`,
`client_id`, `redirect_uri`, `state`, `response_type` or
`include_granted_scopes`, the one flag that defeats per-app tokens on
Google. Apps keep their own `state` and PKCE. In local dev (`everyapp
dev`, no binding) `everyAppWorker()` and `everyAppAuxiliaryWorker()` write
the manifest's capabilities as `EVERYAPP_DEV_CAPABILITIES`, and the SDK's
dev twin applies the same checks against the same sets and answers the same
refusal shape, so `gatewayRefusal()` behaves identically in dev; without
the variable a policy capability is `ready: false`.

## 7. Admin → Apps, and the consent page

`AppService.getAllWithAccessCounts` adds, for the organization's own apps
and for shared ones, a server-computed `capabilities` summary from the
stored manifest and the registry: id, label, access, `why`, the scope
sets' names and labels, and a `scopesStatus` of `ok`, `undeclared` or
`unknown`, so an admin sees why an app is refused. The Apps table shows
one line under the app, `Integrations: Google (Search Console read-only,
Google Analytics read-only) · Context.dev`, and the Edit dialog a read-only
paragraph per capability with the `why` and, for a client with a policy,
"the gateway refuses tokens outside these sets; the app holds the tokens
and calls the provider itself". There is no app-approval UI yet (the Google
design's grants are deferred); the MCP consent page's per-app "reaches
Google (Search Console read-only), Slack" line touches `mcp-auth` and is a
held, lowest-priority follow-up.

## 8. Logging

`integration.proxy.call` gains `scopeSets` (the declared names) for a
client with a policy. A new `integration.proxy.scope_refused` (warn)
carries the caller, the code and the excess scope names on steps 5d, 5e
and 7. Scope strings are public vocabulary and what an operator needs to
debug a refusal; tokens, codes, `id_token`, bodies and the client stay out,
and the "never in logs" test keeps asserting it with the Google and
Microsoft clients and token literals added.

## 9. Honest limits

1. API calls do not pass through the gateway. The route allowlist is tested
   data until the outbound Worker (dispatch tier) or gateway-held tokens
   (every tier) use it. The enforced boundary is what tokens an app can
   obtain, not what it does with them; the provider enforces the scopes.
2. Google and Slack tokens are narrow per app only when the app asks for
   only the status's scopes without `include_granted_scopes`; the mint
   check turns a wider token into a refusal, not a narrower token.
3. On a shared Microsoft client (and a shared Slack installation) the
   provider may hand back a token wider than requested once another app
   obtained wider consent; the gateway refuses it, which is availability
   loss, not narrowing. The provider-side fix is one registered client per
   app (as `youtube` and `google-workspace` are two clients); the
   gateway-side fix is held tokens with the path allowlist.
4. Tokens an app obtained before the gateway deploy are unaffected until
   they need a refresh.
5. A refresh token is not bound to an app; same-or-narrower replay across
   apps on one client is invisible.
6. A refused grant stays granted at the provider: the tokens are inert
   (nobody holds the string) but the person sees the app in their account
   permissions until they remove it.
7. The provider's `scope` field is trusted. Google can be cross-checked
   with `tokeninfo` and Slack with `x-oauth-scopes` later; Microsoft access
   tokens must not be decoded.
8. The boundary exists because the client is confidential; a registry
   invariant forbids a policy on a public client.
9. Per-organization narrowing and admin approval remain the Google
   design's unbuilt grants.
10. `everyapp dev` enforces only with `EVERYAPP_DEV_CAPABILITIES` from the
    SDK's worker builders; a hand-rolled dev harness sees no sets.
11. A hand-crafted hosted deploy bypasses the strict validator;
    `manifestProblems` refuses the cases it knows and the gateway fails
    closed on the rest.

## 10. Evolution into gateway-held tokens

Everything here is kept when the gateway holds tokens (the Google design's
`integration_accounts`): the manifest's `scopes`, `scopePolicy`, the
allowed and granted scope helpers (the mint check stays, now on tokens the
gateway stores instead of forwards), the status's `scopes`, Admin → Apps.
The first gateway PR after launch makes the outbound Worker enforce the
route allowlist for dispatch-tier apps (`OutboundParameters` in
`packages/perimeter/src/getAppFetcher.ts` gains the deployed manifest's
sets per capability; `outbound.ts` runs the matcher and strips
`X-HTTP-Method-Override`, `access_token` and `token`), the only place the
allowlist can be live before held tokens. Then: the gateway builds the
authorize URL and runs the callback itself (so `include_granted_scopes`
and the app's choice of `scope` disappear), stores the response encrypted
with its granted scopes, hands the app an opaque account id, and a
non-token route on a policy host goes to a proxy branch that loads the
account, requires the matcher to cover the call, sets its own bearer and
logs host, path, method and set. Microsoft's and Slack's limit then becomes
a gateway-enforced boundary. Until then, section 5 is the whole boundary.

## 11. Decisions and follow-ups

Defaults and alternatives are in TODO.md under "OAuth scopes
(2026-10-24)", one bullet per decision: named sets rather than raw scope
strings; `scopes` required where a policy exists and refused elsewhere, an
unknown name voiding the grant; no write sets this week; a refused
over-scoped token is dropped, never revoked; a token without a `scope`
field fails closed; Microsoft refused strictly with no advisory flag;
per-capability grant types; request `scope` checked then rewritten per
provider; an explicit `identity` set plus a tolerated baseline; Search
Console and Analytics on the `google-workspace` client; Slack only if time;
shared-consent collisions answered by one client per app; granted and
excess scope names logged on a refusal; the dev twin's variable; the hosted
deploy API refusing unknown sets; outbound-Worker enforcement as the first
post-launch gateway PR; the consent page line held. Follow-ups there: Open
CRM's redeploy (add `scopes` to three entries, drop
`include_granted_scopes`, build the URL from `authorizeUrl()`), OpenSEO's
move onto the gateway's client, and one live check per provider of the
token response's spelling before any production deploy.

## 12. The PR stack

Every PR is opened against `main` (a stacked base's deletion closes its
dependents).

| PR | What | Merge policy |
| --- | --- | --- |
| 1, #398 | Scope policies in the registry for `google-workspace` and `microsoft-365`, the scope parsers and the route allowlist matcher, the generated docs table | SDK data and pure helpers, nothing reads them at runtime until PR 3. Merged 2026-10-24 (`50f3f010`) after an adversarial review whose eight findings were fixed first |
| 2, #414 | The manifest entry takes `scopes`: strict at authoring, lenient on the gateway, the hosted deploy API's `manifestProblems` | Perimeter. Merged 2026-10-24 (`d7258f09`) |
| 3, #411 | The gateway holds each app to its sets at every mint and refresh; the status's `scopeSets` and `scopes` | Gateway security boundary. Merged 2026-10-24 (`bfd7299a`, after #387 `31c73a78`); not deployed to everyapp.team by this work; Open CRM redeploys with `scopes` before `everyapp update` |
| 4, #412 | SDK status type, `authorizeUrl()`, the dev twin | SDK. Merged 2026-10-24 (`a01fac3b`, after #414) |
| 5, #408 | Admin → Apps shows each app's capabilities with their sets and why | Read-only admin UI. Merged 2026-10-24 (`10a07c45`) |
| 6, #393 | This document and TODO.md (merged 2026-10-24); the prose in `docs/capabilities.md` and `docs/security-model.md` rides with PRs 2 and 3 | Docs: auto-merge |
| 7, #425 | Slack's policy: bot sets `channels.read`, `users.read`, `users.email`, `messages.write`, `channels.join`, `channels.manage`, `files.write` and the user set `user-channels.manage` | Registry. Merged 2026-10-24 (`d0c3b73f`); Open CRM redeploys with `scopes` for slack before a Gateway carrying it serves its Slack exchanges |
| 8 | The MCP consent page's per-app reach line | Not built this week; `mcp-auth`, lowest priority |

## 13. What was built, and where it differs from the design above

Built 2026-10-24 by parallel agents, each PR reviewed adversarially (three
finders per PR, two refuters per finding) before it was pushed. The
design above stands; these are the differences a reader checking the code
against it will meet.

- **The scope-refusal log line carries the code under `reason`, not
  `code`.** The perimeter's log redaction treats any field whose name
  matches `code` as a secret, so `code` would always read `[redacted]`;
  `reason` is what `egress.denied` uses. The line is
  `integration.proxy.scope_refused` with the caller, `reason` and the
  (capped) `excess` list.
- **`client_credentials` is refused by #387's user-grant floor** (step
  5c, before the client is injected) with its message; the policy's own
  grant-type check (5d) then refuses a token exchange or an absent
  `grant_type` for Google and Microsoft with the message in section 5.
  Both use `integration_grant_not_allowed`.
- **Two more request rules.** `grant_type` named twice in a form body is
  400 `integration_body_invalid` (the first copy would decide while the
  provider saw both). The `integration_scope_not_allowed` message and log
  name the first ten scopes in excess, each cut to 128 characters, with
  "and N more": the list is app-controlled and the body may be 64 KiB.
- **A provider answer that breaks off while the gateway reads it** is
  502 `integration_upstream_failed` (phase `answer` in the log), never a
  500; nothing is forwarded.
- **The status answers `scopeSets` and `scopes` for a valid grant whether
  or not the gateway holds the client** (`configured: false`, `ready:
  false`, no `clientId` when it doesn't): the scope vocabulary is public
  registry data.
- **`authorizeUrl()` builds URLs for clients with a scope policy only.**
  For a client without one (Slack today, Postiz's networks) it throws a
  `TypeError` naming the fix, rather than falling back to the registry's
  checklist: Slack's checklist mixes bot and user scopes, and a
  fallback would have put user scopes in `scope` without `user_scope`.
  It also reserves `code_challenge`, `code_challenge_method`,
  `access_type` and `response_mode` besides the seven in section 6.
- **The dev twin applies the gateway's check 2 too** (a client the
  manifest doesn't list is `capability_not_requested`, and its status
  `requested: false`), and its refusal messages say "start `everyapp dev`
  again" where the gateway's say "deploy again".
- **Admin → Apps** reads "Google (Google account, Gmail read-only, Google
  Calendar read-only)" in the table (the identity set by its noun, the
  access qualifier unbracketed), "Google (no usable scope sets)" for a
  void grant, and the dialog leads with "tokens for <sets>" rather than
  the entry's `write` access, which would read "write access to Gmail
  (read-only)". The summary lives in
  `src/server/services/appCapabilities.ts`.
- **The route matcher** refuses a dot segment with a path parameter
  (`..;`, `%2e%2e;`), which Google's front end resolves as `..` and the
  URL parser does not; it compares denied words against whole segments,
  so a Search Console property whose own URL holds `batch` or a
  percent-encoded byte stays matchable; and it reads `scope` fields in
  any case, as Entra does. The matcher's comment records that the future
  proxy must fetch with `redirect: "manual"`.
- **Slack's policy** (#425) merged 2026-10-24 (`d0c3b73f`): a gateway
  carrying it and #411 fails Open CRM's Slack exchanges closed until it
  redeploys with `scopes` for slack. The MCP consent page line (PR 8)
  was not built.

