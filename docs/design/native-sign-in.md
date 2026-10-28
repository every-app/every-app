# Sign in with Every App: native apps

Date: 2026-10-26. Status: built on `feature/native-sign-in` (lanes a–d, #861 #860 #859 #858) and reviewed 2026-10-27 (`native-sign-in-review.md`); the umbrella PR #855 is a draft and stays one until Ben says otherwise. The first client is OpenZen's macOS app (a meeting recorder), which signs in to one Gateway and talks to one app's API (`https://open-zen.<base>`) as the person.

Ben is not sure the platform should support this at all. Section 9 says why it should, and what it costs; TODO.md "Native sign-in (feature/native-sign-in)" holds the decisions taken and the questions left.

## 1. What exists

The Gateway is already an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider` 1.2.3, `apps/every-app-gateway/src/server/mcp-auth/`): dynamic registration and Client ID Metadata Documents, PKCE S256 required of every client, a consent page, opaque access tokens (1 hour) and rotating refresh tokens (30 days, sliding), RFC 7009 revocation, and a `mcp_connections` row per consent that every request re-reads. It issues tokens for exactly one resource, `${GATEWAY_URL}/mcp` (`mcp.one-protected-resource`), and an app host refuses any token of that shape on every route (`mcp.app-host-refuses-oauth-tokens`). App routes take a personal access token with `*` scope, or a browser session, and nothing else (the one scope rule, `packages/perimeter/src/session.ts`).

The library binds every grant and token to one registered resource (RFC 8707), validates loopback redirect URIs with RFC 8252 port handling, and refuses private-use schemes unless asked. The deleted mobile app (#442, f6207144) never used any of this: it signed in with a password inside the app, held a full Gateway session cookie, and trusted `everyapp://` as a prefix, which is why it went.

## 2. The idea in one sentence

A native app is an OAuth client of the Gateway like Claude is, except its `resource` is the app host's origin instead of `/mcp`, so the token it gets opens that one app, as the member, and nothing else.

Nothing new is minted: the same server, the same token format, the same KV, the same connection row, the same revocation paths. What changes is the list of resources the server knows, the consent page for an app resource, and one branch in the app-host authenticator that validates such a token instead of refusing it.

## 3. The flow

```
  Mac app                 system browser              Gateway (gateway host)          App host (open-zen.<base>)
    |                          |                            |                               |
    | 1. person types the app URL (https://open-zen.<base>)  |                               |
    |------------------------------------------------------------------------------------>| GET /.well-known/oauth-protected-resource
    |<------------------------------------------------------------------------------------| { resource, authorization_servers: [gateway] }
    | 2. GET /.well-known/oauth-authorization-server         |                               |
    |------------------------------------------------------->|                               |
    |<-------------------------------------------------------| issuer, endpoints             |
    | 3. POST /oauth/register (once per install; or a CIMD client id)                       |
    |------------------------------------------------------->|                               |
    |<-------------------------------------------------------| client_id                     |
    | 4. listen on http://127.0.0.1:<free port>/callback     |                               |
    | 5. open /oauth/authorize?...&resource=https://open-zen.<base>&code_challenge=...        |
    |------------------------->|  (Access login if the outer ring is on, then Gateway sign-in)|
    |                          |--------------------------->| consent: "OpenZen for Mac      |
    |                          |<---------------------------|  wants to use OpenZen as you"  |
    |                          | Allow                      |                               |
    |                          |--------------------------->| mcp_connections row (kind native)
    |<-------------------------| 302 http://127.0.0.1:<port>/callback?code&state&iss         |
    | 6. POST /oauth/token (code, code_verifier, resource)   |                               |
    |------------------------------------------------------->|                               |
    |<-------------------------------------------------------| access_token (1 h), refresh_token
    | 7. Authorization: Bearer <access_token>                |                               |
    |------------------------------------------------------------------------------------>| perimeter validates (audience = this host),
    |                                                        |                               | re-reads the connection, mints the identity JWT,
    |<------------------------------------------------------------------------------------| the app answers as for a PAT
    | 8. refresh before expiry; "Sign out" revokes the refresh token                        |
```

The browser is always the system browser, never a web view: the person signs in on the Gateway's own page (and through Cloudflare Access, where it is on), and the app never sees a password or a session cookie.

## 4. Endpoints

| Endpoint | Host | Today | With this design |
| --- | --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` | app host | 404, never proxied | Served by the Gateway from the registry for an active first-party app: `{ "resource": "https://<host>", "authorization_servers": ["<GATEWAY_URL origin>"], "resource_name": "<app name>" }`. Still never proxied, still 404 for an unknown or inactive app. Lets the person type the one URL they know. |
| `GET /.well-known/oauth-authorization-server` | gateway | served | unchanged |
| `POST /oauth/register` | gateway | served, budgeted | unchanged |
| `GET /oauth/authorize` | gateway | `resource` must be `/mcp` | `resource` may be an active first-party app host's origin; then the consent page is the app variant (section 6) |
| `POST /oauth/consent/decision` | gateway | records an MCP connection | for an app resource, records a `kind: "native"` connection for that one app |
| `POST /oauth/token` | gateway | code, refresh, revocation | unchanged; `resource` must match the grant |
| any route | app host | refuses OAuth-shaped bearers | a token whose audience is this host is validated and acts as the member (section 7) |

The `MCP_OAUTH_ENABLED` and `MCP_DCR_ENABLED` switches cover native sign-in too: with OAuth off, no native app can sign in. No new switch.

## 5. Resources and tokens

**Resources.** The authorization server is built with `/mcp` plus the origin of every active first-party app host (`https://${row.hostname}`; on the issuer's scheme, so `http://` where a development gateway is an http issuer on localhost), read from the apps registry, with `/mcp` as `defaultResource` so MCP clients that omit `resource` keep working. The list is fixed at construction, so the server is rebuilt per isolate when the set of hostnames changes (checked at most once a minute, and once more when a request names a resource the current build doesn't know, which is itself rate-limited to one registry read per ten seconds so a client naming invented origins can't make a read per request). A deleted or disabled app's origin leaves the list, and `validateToken` then rejects its tokens; the perimeter calls it through `validateAppHostToken(env, origin, token)`, which answers null for an origin not in the list (the library throws for an undeclared resource). Dispatch-tier apps on third-party hosts are not resources in this version. *As built (lane a): `mcp-auth/resources.ts`, `config.ts`.*

**Telling a native grant from an MCP one.** By the resource, never by the client. A client may hold both (Claude Desktop could one day hold an `/mcp` grant and a native grant for one app); they are separate grants with different audiences.

**Token.** The library's opaque `{userId}:{grantId}:{secret}` (the perimeter already recognizes the shape as reserved: `isGatewayOauthToken`), access token 1 hour, refresh token 30 days sliding, rotated on use with the previous one valid until the new one is first used (no reuse detection: known gap B5). Props stored with the grant, ids only:

```ts
type NativeGrantProps = {
  v: 1;
  kind: "native";
  connectionId: string;   // mcp_connections.id
  userId: string;
  organizationId: string;
  appRowId: string;       // the one app
};
```

**Scope.** `*`, full member scope on that app, the same meaning the one scope rule gives a personal token: app routes never read scopes, and `/mcp` on the app host (where its manifest serves one) takes `*` too. The client omits `scope`; for an app resource the server ignores whatever scope was requested (`app:open-zen` included) and grants `*`, which the token response's `scope` says. The binding to the app is the resource, never a scope string: a scope is a request, the audience is what the library checks on every validation. There is no read-only native grant (a token narrower than `*` opens no app route; adding that would reopen what #757 closed).

**Connection row.** `mcp_connections` gains `kind` (`"mcp"` | `"native"`, default `"mcp"`) and `resource` (the audience; null on rows from before, which are `/mcp`). A native row has `app_scope: "selected"` with one `mcp_connection_apps` row, `access: "write"`, the client's name and redirect host as today. Every request re-reads it, so revoking it or narrowing anything takes effect on the next request without a new token. Revoked reasons gain `app_removed`. The authorization server's `scopes_supported` lists `*` besides the MCP scopes (the library only approves scopes it supports); the MCP consent never grants it.

## 6. Consent

The page is `routes/oauth/consent.tsx` with a second variant chosen by the resource:

- **Who:** the client's name, with its verified domain when the client id is a metadata document ("openzen.app"), or "unverified: this app chose its own name" for a dynamically registered client.
- **What:** "wants to use **OpenZen** (open-zen.<base>) as you, in **<organization>**: everything you can do there." No app picker, no read-only choice. For an organization's app the organization is fixed by the host; for a shared app on the hosted tier the person picks one of their organizations, as the MCP page does.
- **Where the code goes:** "Back to the app on this computer (127.0.0.1)" for a loopback redirect, the host for an https one.
- Allow / Don't allow. The same transaction rules: 10 minutes, bound to the browser, spent once, decision from a same-origin form by a signed-in member.

A person who can't open the app in the browser (no `user_app_access` row, deactivated, suspended organization) can't grant it: `consent.choices-validated-before-spend` extends to the app resource.

## 7. The perimeter and the SDK

In `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`, the branch that today returns `null` for any non-`epat_` bearer becomes:

1. If the bearer is OAuth-shaped and the request is on an app host: `getMcpAuth(env).authorizationServer.validateToken("https://" + app.hostname, token, env)`. Null (wrong audience, expired, unknown) → `null`: the request fails closed, exactly as a bad PAT does, never anonymous.
2. Props must be `kind: "native"` (an `/mcp` grant's props never validate here anyway: wrong audience). Re-read the connection (`findActiveWithMembership`): revoked, another user or organization, member since after the grant, banned, organization not active → `null` (and the member-removed case revokes the row, as `resolveOauthCaller` does).
3. Return the session a PAT would: `{ sub, email, orgId, orgRole, orgName, credential: { kind: "oauth", channel: "api", actor: "oauth:<connectionId>", scopes: ["*"] }, credentialAppRowId: appRowId }`.

`hasAppAccess` then runs unchanged: organization match, active organization, `user_app_access`, and `boundToAnotherApp`, which is extended from `kind === "pat"` to any credential with a `credentialAppRowId` (belt and braces: the audience already binds it). The identity JWT the app receives carries `chan: "api"`, `act.sub: "native:mcpc_…"`, `scopes: ["*"]`.

**The SDK changes nothing.** `getEveryAppUser()` already verifies the JWT and exposes `user.channel` and `user.actor`; an app that wants to treat native clients differently (a desktop recorder uploading audio) reads `user.channel === "api"` and the actor's connection id (`oauth:`, as MCP tool calls carry, on the `mcp` channel). Documented, not enforced.

**Bearer routes: working behind Cloudflare Access is a hard requirement.** Access is on by default on self-hosted gateways since 2026-10-26 (`setup` turns it on; everyapp.team runs it), in front of the Gateway's host and every app host, and lets only each app's public routes through. A bearer-only request to an app host gets Access's HTML login; the service-token workaround for personal tokens is unverified live.

How `/mcp` works behind Access today, since MCP clients already present bearers: the Gateway's Access application bypasses `/mcp`, `/oauth/token`, `/oauth/register` and `/.well-known/*` by path, and the Gateway checks its own credential on each of them (`docs/runbooks/cloudflare-access.md`, "Let through only the machine endpoints, which check their own credentials"). `/oauth/authorize` and the consent pages stay behind Access, since a person in a browser passes it. With Managed OAuth instead, Access itself is the authorization server for MCP clients and the bypasses go away.

Access decides by path, host and service token, never by an `Authorization` header, so there are three ways and no fourth:

1. **A path bypass the app declares, which the perimeter then verifies** (chosen). Routing native calls through the Gateway's host instead would change nothing: that host is behind the same Access and its bypasses are the four machine paths above.
2. **Access's Managed OAuth for native apps**: Access becomes their authorization server; its token opens every app host the person can use, not one app, and the Gateway would have to accept Access assertions on app hosts. Recorded as the alternative for Ben.
3. **A service token in the app**: refused; a public client cannot keep a secret.

So the manifest gains:

```ts
bearerRoutes: { paths: ["/api/**"], why: "The Mac app calls the API with its token." }   // globs as `public`; methods all; `why` is shown to the operator, as `mcp.why` is
```

A bearer route takes a bearer only: the perimeter answers 401 to a cookie there on every gateway, Access or not (behind the outer ring a cookie without an assertion already counts for nobody on a bypassed path; this makes dev and self-host behave the same). `everyapp access on` bypasses these paths on the apps' application (and `/.well-known/oauth-protected-resource`, for discovery); `status` reports drift as it does for public routes. An app whose web UI calls the same paths must split them, which is the trade the design makes rather than letting cookies through a hole in Access. A native token works on every route the member can reach; `bearerRoutes` only says which of them Access lets a token reach.

**Built (lane b, 2026-10-27), and where it departs from the text above.** `betterAuthAuthenticator.ts` validates an OAuth-shaped bearer with the audience `${issuer scheme}//${Host header}` (https in production; a local Gateway on http gets http origins, so lane a's `appResourceOrigin` should take the issuer's scheme too), through lane a's `validateAppHostToken` (null for an origin the server doesn't declare) and `resolveNativeCaller` (the one re-read of the connection), both loaded on the first native token an isolate sees rather than with the perimeter, since importing the OAuth server's module graph statically cost every fresh isolate's first page request a database round trip. The audience is held once more in `hasAppAccess`: a native session is refused on a served app whose registered hostname isn't the origin it validated for, beside the `appRowId` check. An OAuth-shaped bearer the authenticator refuses (revoked, another host's, the gateway's `/mcp` token) fails closed on public routes as well, as a bad personal token does (the reserved-bearer rule), rather than being served anonymously. The bearer-route cookie refusal matches the gateway's own session cookie names (the authenticator's `sessionCookieNames`), not any `Cookie` header: a native client's HTTP stack may hold the app's own cookies, which the perimeter strips anyway. A bearer route wins over a public route or public asset on the same path (the manifest refuses the overlap at author and registration time; a row stored before that rule is served to a bearer only). The metadata document is served for an active app only; an inactive app's host keeps its usual 503 for every path, and the 401 challenge on app hosts names the document in `resource_metadata` (RFC 9728 §5.1), which the client contract does not need but a generic client uses. The document is served only while `MCP_OAUTH_ENABLED` is on and never on a third-party host.

## 8. Revocation and lifetimes

| Ends a native grant | How fast |
| --- | --- |
| The person revokes it under Settings → Connections (the AI connections page, with a second table "Apps on your devices") | next request |
| The app's "Sign out": RFC 7009 revocation at the token endpoint with the refresh token; the row becomes `ended` | next request |
| Member removed from the organization, or deactivated | next request (the row is revoked on the way) |
| The app deleted or disabled | next request once the origin leaves the resource list (within a minute); the rows are revoked when the app row goes through the Gateway (as app-bound PATs are), and by the hourly maintenance for an app the CLI deleted or disabled in the registry directly |
| Re-consent from the same client for the same app | the earlier grant is revoked and the earlier row marked `superseded`: by installation (`McpConnectionService.supersedeEarlier`, the mechanism MCP connections use, scoped to the same resource), not the library's default, which for a metadata-document client compares redirect URIs exactly and so would miss a Mac app that listens on a new loopback port each launch; a grant for another app from the same client stays |
| 30 days idle | the hourly maintenance cron, as for MCP grants |

Nobody but the person revokes their own connection (B5's existing gap: an admin can't). Access tokens live 1 hour; a stolen access token is good for at most that on one app; a stolen refresh token until the device refreshes twice or the person revokes.

Events: `connection.created` and `connection.revoked` gain `kind` and `app`; no new event names.

## 9. Should the platform do this at all?

What it buys: a native app (OpenZen's Mac recorder first, a phone client later) signs in through the Gateway's own page, behind Access where the operator has it, with a consent screen, a revocable app-bound token and no password in the app. Without it, native apps have two paths, both worse: paste a personal access token (90 days, `*` on every app, created from a page only owners and admins can open today, revoked by hand, and refused by Access on app hosts with no verified workaround) or embed a web view and hold the Gateway's session cookie (what the deleted mobile app did, with the problems #442 lists).

What it costs: no new credential kind, server or store; four lanes (section 11), roughly two agent-days plus a live run; one new manifest field; two threat-model invariants rewritten and seven added. The new way into app hosts is the existing OAuth server with the audience checked per host.

Recommendation: yes, in this shape, first-party hosts only, and the OpenZen app as the proof before it is documented for others.

## 10. Threats

| Threat | Answer |
| --- | --- |
| **Phishing by a typed URL.** The person types `https://evil.example` as "their" app. | The app only talks to the origin typed and its discovery documents; `issuer` must equal the authorization server's origin and the `iss` in the authorization response (RFC 9207, always on). The person signs in on that site's page in the system browser, where the address bar shows the host; the app never collects a password. Same exposure as any link; the app shows the host it is signed in to. https required; http only on loopback for development. |
| **Loopback port hijack.** Another local process listens on the callback port. | The app binds a free port first, then starts the flow (RFC 8252 §7.3). A code delivered to the wrong listener is useless without the PKCE verifier, which stays in the app's memory, and the Gateway refuses a code exchange without it. A malicious local process is outside the model (it can read the keychain too). |
| **Custom-scheme hijack.** Two apps claim `openzen://`. | Not enabled: `allowPrivateUseRedirectUris` stays false, and a request using such a URI is refused. iOS clients use a claimed https Universal Link, which the library accepts as an https redirect. |
| **Code injection / login CSRF.** | `state` checked by the app; PKCE bound to the app's verifier; redirect URI exact (loopback port free). Errors before the client and redirect URI are validated are shown on the Gateway's page, never redirected (`oauth.errors-never-redirected`). |
| **Token replay elsewhere.** A native token sent to `/mcp` or another app host. | Audience: `validateToken` for another resource answers null; `/mcp` answers `invalid_token`. Pinned by a test in both directions. |
| **Token theft from the device.** | One app, one organization, as the member; 1 hour; refresh rotates; revoke from Settings. Apps see `chan: "api"` and can treat uploads from a native client with their own care. |
| **Impersonation on the consent page.** Any app can call itself "OpenZen". | Names of dynamically registered clients are marked unverified; a metadata-document client shows its domain. The page names the app host and organization the grant opens. OpenZen ships with a metadata document on its own domain. |
| **Access.** | `/oauth/authorize` and the consent pages stay behind Access (people, in the browser). `/oauth/token` and `/oauth/register` are bypassed today. App routes: only `bearerRoutes` (and the metadata path) are bypassed, and they take no cookie, so the bypass opens nothing to a browser; everything the perimeter does for a personal token (live membership, app access, audience) runs there. |
| **A forged app host metadata document.** | Written by the Gateway from the registry, never proxied, never under a public route; names only the Gateway as authorization server. |
| **Registration flood.** | The existing per-address and per-gateway daily budgets. |
| **Lost membership.** | Per-request re-read of the row, role, ban, organization status and app access, as for MCP tokens. |
| **The hosted tier.** | Shared apps: the organization is chosen at consent and fixed in the token. Third-party (dispatch) hosts: not resources yet; a native token there is refused as today. |

Out of scope: the native app's own storage of its tokens, and what the app does with a valid identity.

## 11. Lanes

Lane a merges first; b and c can start against its contract and merge after it; d last.

**a. Gateway authorization server and token issuance** (owns `apps/every-app-gateway/src/server/mcp-auth/*`, `src/db/mcp.schema.ts` + migration, `src/server/repositories/McpConnectionRepository.ts`, `src/server/services/McpConnectionService.ts`, `packages/sdk/src/internal/events.ts`)
- `config.ts`: resources from the registry, `defaultResource: /mcp`, the rebuild rule (section 5); a new `resources.ts` with `appResourceOrigin(hostname)` and the cached list.
- `validate.ts`: `NativeGrantProps`, `resolveNativeCaller(props)` (exported for lane b), `/mcp` still refusing native props.
- `authorize.ts` + `consent.ts`: the app-resource branch (no app picker, scope `*`, kind `native`; grant replacement by installation and resource, see §8). The decision form carries the `resource` the page showed, checked against the stored request as `client_id` is.
- Schema: `kind`, `resource`; revoke native rows when an app is deleted or disabled.
- Tests in a new `native-sign-in.e2e.sqlite.test.ts`: a native grant is issued for an app origin and refused at `/mcp`; an `/mcp` token is refused for an app origin; consent needs app access; revocation paths.

**b. Perimeter and SDK acceptance** (owns `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`, `packages/perimeter/src/gateway.ts`, `publicRoutes.ts`, `manifest/*`, `registry/apps.ts`, `packages/sdk/src/manifest.ts`)
- The authenticator branch (section 7), `boundToAnotherApp` for any bound credential.
- `bearerRoutes` in the manifest and its validation; the perimeter's cookie refusal there; the gateway-authored metadata document on app hosts (`perimeter.no-oauth-metadata-on-app-hosts` becomes "gateway-authored only").
- Tests: `betterAuthAuthenticator.test.ts` (validates a native token for its host, refuses it for another, fails closed on a revoked row), `gateway.test.ts` (bearer routes refuse cookies; metadata served from the registry and never proxied), a new `app-host-native.sqlite.test.ts` end to end.

**c. Gateway UI** (owns `apps/every-app-gateway/src/routes/oauth/consent.tsx`, `src/routes/_app/settings/connections.tsx`, the connection server functions and schemas under `src/serverFunctions/` and `src/schemas/consent-decision.ts`)
- The consent variant (section 6); the "Apps on your devices" table with revoke; the account menu copy if any.
- Tests: the consent page's native copy; the connections page lists and revokes a native row.

**d. Docs and CLI** (owns `landing-page/content/agent/native.md` (new), `manifest.md`, `identity.md`, `access.md`, `landing-page/content/docs/native-sign-in.mdx` (new), `docs/runbooks/cloudflare-access.md`, `docs/security-model.md`, `packages/cli/src/lib/access/plan.ts`, `packages/cli/src/commands/status/*`, the docs drift tests under `packages/cli/src/docs`)
- The client contract (section 12) as the agent page; `bearerRoutes` in the manifest reference; the Access runbook's bypass table; `access on` and `status` drift for bearer routes and the metadata path.
- The threat-model rows this PR adds get their `path:line` and test names once a–c are in. *Done by the review (2026-10-27), with the perimeter's end-to-end cases in `native-sign-in.e2e.sqlite.test.ts` instead of a separate `app-host-native.sqlite.test.ts`.*

Not in any lane (yet): `everyapp dev` mirror mode forwarding a native token to the local Gateway's `/api/dev/identity` (section 13, ask 7); `everyapp dev` serving the flow locally (the Mac thread tests against a deployed Gateway, or a local one on `http://localhost`, which the issuer rule allows); dispatch-tier hosts; a device name on the connection row; an admin revoking a member's connection.

## 12. The client contract

What a native app does. OpenZen's Mac thread codes against this.

1. **Ask for the app's URL**, the one the person uses in the browser: `https://open-zen.<base>`. Keep the origin only. Require https (allow http only for `localhost` / `127.0.0.1` in a developer build).
2. **Discover.** `GET {origin}/.well-known/oauth-protected-resource` → `resource` (must equal the origin) and `authorization_servers[0]` (the Gateway). Then `GET {gateway}/.well-known/oauth-authorization-server` → `issuer` (must equal `{gateway}`), `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `registration_endpoint` (absent when the operator turned registration off: tell the person, or use a metadata-document client id).
3. **Be a client.** Either register once per install, `POST {registration_endpoint}` with
   ```json
   { "client_name": "OpenZen for Mac", "redirect_uris": ["http://127.0.0.1/callback"],
     "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
     "token_endpoint_auth_method": "none" }
   ```
   and keep `client_id` (it lasts 60 days unused and is renewed by use; on `invalid_client`, register again); or ship a Client ID Metadata Document at a URL on your own domain (`https://openzen.app/oauth/client.json`, the same fields plus `"client_id"` equal to its URL) and use that URL as `client_id`, which puts a verified domain on the consent page. Do both: start with registration, ship with the document.
4. **Listen** on a free port on `127.0.0.1`, path `/callback`.
5. **Authorize** in the system browser:
   ```
   {authorization_endpoint}?response_type=code&client_id=…&redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcallback
     &code_challenge={S256(verifier)}&code_challenge_method=S256&state={random}&resource={origin}
   ```
   No `scope`. The redirect's port may differ from the registered URI; everything else must match.
6. **On the callback**, check `state`, check `iss` equals the issuer, then exchange:
   ```
   POST {token_endpoint}   application/x-www-form-urlencoded
   grant_type=authorization_code&code=…&redirect_uri=http://127.0.0.1:{port}/callback&client_id=…&code_verifier=…&resource={origin}
   ```
   → `{ "access_token", "token_type": "Bearer", "expires_in": 3600, "refresh_token", "scope": "*", "resource": "{origin}" }`. Answer the browser with a short "You can close this window" page.
7. **Call the app**: `Authorization: Bearer {access_token}` on `{origin}/…`. The app sees you as the member who consented, through the normal identity (`channel: "api"`, actor `oauth:<connection id>`).
8. **Refresh** before `expires_in` runs out, or on a 401 `invalid_token`:
   ```
   grant_type=refresh_token&refresh_token=…&client_id=…&resource={origin}
   ```
   Store the new refresh token at once (the old one dies when the new one is first used). `invalid_grant` means the grant is gone (revoked, member removed, 30 days idle): sign in again.
9. **Sign out**: `POST {revocation_endpoint}` with `token={refresh_token}&token_type_hint=refresh_token&client_id=…`, then forget everything.
10. **Store** tokens in the Keychain; never log them; show the host you are signed in to; use the system browser, never a web view; one Gateway per sign-in (a second account is a second sign-in).

**Rules for the app's API side** (the app the native client talks to): its endpoints are plain route files on the app host (`/api/...`), never TanStack server functions: `/_serverFn` admits same-origin requests only, so a bearer client can't reach them. Every one of them reads the user with `getEveryAppUser()` as any route does. Apps can't read groups today, so a native client can't be scoped by group.

Behind Cloudflare Access the person logs in to Access in the browser during step 5; the app's calls need the app's manifest to list the paths they use under `bearerRoutes`, or they get an HTML login page. An app that gets one should tell the person to ask the operator.

## 13. The consumer's asks

OpenZen's spec (`open-notes/docs/SPEC.md` at 3d53f6d, "What OpenZen needs from the platform") lists eight needs, each verified missing in the checkout on 2026-10-27. Each is accepted or not, with the reason.

| # | Ask | Answer |
| --- | --- | --- |
| 1 | The perimeter accepts a Gateway-issued OAuth access token on an app host's private routes and mints that person's identity (`chan: "api"` or a new channel, `act.sub: "oauth:<id>"`, `scopes: ["*"]` for that one app). | **Accepted** as written: channel `api` (no new channel: a native client is an API client, as a script with a personal token is), actor `oauth:<connection id>`, the prefix MCP tool calls already carry on the `mcp` channel, scopes `["*"]`. Section 7. |
| 2 | The token is bound to one app (`scope=app:<id>` and/or RFC 8707 `resource`) and refused on every other app. | **Accepted by resource, not by scope.** The audience is what the library checks on every validation; a scope is only a request. `scope=app:open-zen` is ignored and the grant is `*`. Section 5. |
| 3 | DCR of a public native client: auth method `none`, loopback `http://127.0.0.1/callback` with any port. | **Accepted**; the library does both already, and registration is budgeted as for MCP clients. A metadata-document client id is recommended for the shipped app (verified name on consent). Section 12. |
| 4 | Access lets bearer calls through on the app's API paths through a manifest opt-in (`nativeClients: { paths, why }`), the way `access on` bypasses `/mcp`; the perimeter still demands the token. | **Accepted**, named `bearerRoutes: { paths, why }`: the mechanism serves scripts with personal tokens too, not native clients alone. Bearer-only: a cookie there is 401 everywhere. Section 7. |
| 5 | Any member can approve a native app, not only owners and admins. | **Accepted**: anyone who can open the app in the browser. TODO.md question 6 (recommended yes). |
| 6 | Revocation: the grant on the Connected AI clients page, a revocation endpoint, and deactivation revoking it. | **Accepted**: the AI connections page gains "Apps on your devices"; RFC 7009 at the revocation endpoint; member removal, deactivation, app deletion and 30 idle days revoke too. Section 8. |
| 7 | `everyapp dev`: mirror mode verifies the new token on app routes; stub mode keeps "any bearer is the dev user". | **Stub accepted, mirror deferred.** Stub mode is unchanged. Mirror mode forwards `epat_` bearers to the local Gateway's `/api/dev/identity`; forwarding an OAuth-shaped bearer needs that endpoint to know which app's origin to validate against, and a dev app's origin (`http://open-zen.localhost:<port>`) is not a resource the library accepts (`http` only on `localhost` itself). A dev-only resource form is a follow-up in TODO.md; until then OpenZen develops its Worker in stub mode and tests the token against a deployed Gateway. |
| 8 | Short access tokens (an hour or less) with rotating refresh tokens. | **Accepted**: 1 hour, rotating refresh with the previous one valid until the new one is first used (the library's rule; replay is not detected, B5's known gap). Section 5. |

One divergence from the spec's flow: its step 1 discovers from the Gateway URL the person typed and then names `resource=https://open-zen.<base>` without saying where the app host comes from; the Gateway's server metadata does not name app hosts, and `APP_BASE_DOMAIN` need not be the Gateway's host. The design has the person type the app's URL (what they use already) and the app discover the Gateway from the metadata the Gateway serves there (section 4). If OpenZen must take the Gateway URL, it needs a second field for the app host.
