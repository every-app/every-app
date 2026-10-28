---
title: "Native apps: Sign in with Every App"
description: "How a Mac or phone app signs a person in to one EveryApp app through the Gateway's OAuth server: how an app opts in with bearerRoutes, the client contract step by step (discovery, registration or a metadata document, the loopback redirect, PKCE, the resource, refresh, sign-out), what the app receives, revocation, and Cloudflare Access."
metaTitle: "Native apps: Sign in with Every App"
metaDescription: "How a native app signs in to one EveryApp app through the Gateway: bearerRoutes, discovery, PKCE, the resource indicator, refresh and sign-out."
---

A native app (a Mac recorder, a phone client) signs the person in through the Gateway's own sign-in page in the system browser and gets a token that opens **one app, as that member, and nothing else**. It is an OAuth client of the Gateway like an AI app is, except its `resource` is the app host's origin (`https://openzen.<base>`) instead of the Gateway's `/mcp`. No password or session cookie ever reaches the native app.

Nothing new is minted: the same OAuth server, token format and connection rows as [MCP](/docs/agent/mcp). The design is `docs/design/native-sign-in.md`; the person's page is [Sign in from a desktop or phone app](/docs/native-sign-in).

## What the app's author does

Add the paths the native app calls to the manifest:

```ts
// everyapp.config.ts
bearerRoutes: { paths: ["/api/**"], why: "The Mac app calls the API with its token." },
```

- A bearer route takes a token and refuses a session cookie (401, `reason: "cookie_on_bearer_route"`); with no bearer it answers the 401 challenge, never a login page. So keep the web UI's calls elsewhere (its server functions, or `/app/api/**`).
- Behind Cloudflare Access, `deploy` and `access on` let these paths and `/.well-known/oauth-protected-resource` through on the app's host. Without the field the native app's calls get Access's HTML login there. Without Access the field changes nothing but the cookie refusal.
- `why` is shown to the operator, as `mcp.why` is.
- The token works on every route the member can reach; `bearerRoutes` only decides what Access lets through. Full field rules: [Manifest](/docs/agent/manifest#bearerroutes).

In the handler, a native caller is an ordinary member: `getEveryAppUser()` returns them with `channel: "api"`, `actor.sub` `oauth:<connection id>` and `scopes: ["*"]` ([Identity](/docs/agent/identity)). Treat uploads from a device with whatever care the app needs; nothing else changes.

In development, `everyapp dev`'s stub mode treats any bearer as the dev user, so the Worker runs as usual; mirror mode doesn't check native tokens yet (a dev app's `http://<app>.localhost` origin isn't a resource the OAuth server takes). Test the real token against a deployed Gateway.

## The client contract

What the native app does. `{origin}` is the app's URL, `{gateway}` the Gateway's.

1. **Ask for the app's URL**, the one the person uses in the browser. Keep the origin only. Require https (http only for `localhost` or `127.0.0.1` in a developer build).
2. **Discover.** `GET {origin}/.well-known/oauth-protected-resource` → `resource` (must equal `{origin}`) and `authorization_servers[0]` (the Gateway). Then `GET {gateway}/.well-known/oauth-authorization-server` → `issuer` (must equal `{gateway}`), `authorization_endpoint`, `token_endpoint`, `revocation_endpoint` and `registration_endpoint` (absent when the operator turned registration off: use a metadata document, step 3, or tell the person).
3. **Be a client**, either way, ideally both (register while building, ship the document):
   - Register once per install, `POST {registration_endpoint}`:
     ```json
     {
       "client_name": "OpenZen for Mac",
       "redirect_uris": ["http://127.0.0.1/callback"],
       "grant_types": ["authorization_code", "refresh_token"],
       "response_types": ["code"],
       "token_endpoint_auth_method": "none"
     }
     ```
     Keep `client_id`. It lapses after 60 days unused; on `invalid_client`, register again.
   - Or publish a Client ID Metadata Document on your own domain (`https://openzen.app/oauth/client.json`: the same fields plus `client_id` equal to its URL) and use that URL as `client_id`. The consent page then shows "Published by openzen.app" instead of "Unverified · This app chose its own name."
4. **Listen** on a free port on `127.0.0.1`, path `/callback`. Bind first, then start the flow.
5. **Authorize** in the system browser, never a web view:
   ```text
   {authorization_endpoint}?response_type=code&client_id=…
     &redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcallback
     &code_challenge={S256(verifier)}&code_challenge_method=S256
     &state={random}&resource={origin}
   ```
   No `scope`. The port may differ from the registered redirect URI; nothing else may. The person signs in (through Access first, where it is on) and sees "OpenZen for Mac wants to use OpenZen": "It wants to use OpenZen (openzen.<base>) as you, in <workspace>: everything you can do there.", "Back to the app on this computer (127.0.0.1)", and **Don't allow** / **Allow**. A member who can't open the app in the browser (no access, deactivated, organization suspended) gets a page titled "Can't sign in" and no grant.
6. **On the callback**, check `state` and that `iss` equals the issuer, then exchange (`application/x-www-form-urlencoded`):
   ```text
   POST {token_endpoint}
   grant_type=authorization_code&code=…&redirect_uri=http://127.0.0.1:{port}/callback
     &client_id=…&code_verifier=…&resource={origin}
   ```
   → `access_token` (1 hour), `token_type: "Bearer"`, `expires_in: 3600`, `refresh_token`, `scope: "*"`. Answer the browser with a short "You can close this window" page. `invalid_target` means the Gateway doesn't know `{origin}` as an app (deleted, disabled, or not on this Gateway); an app deployed a moment ago is learned on the first request naming it.
7. **Call the app**: `Authorization: Bearer {access_token}` on `{origin}/…`.
8. **Refresh** before `expires_in` runs out, or on a 401 `invalid_token`:
   ```text
   grant_type=refresh_token&refresh_token=…&client_id=…&resource={origin}
   ```
   Store the new refresh token at once; the old one dies when the new one is first used. `invalid_grant` means the grant is gone (revoked, member removed, 30 days idle): sign in again.
9. **Sign out**: `POST {revocation_endpoint}` with `token={refresh_token}&token_type_hint=refresh_token&client_id=…`, then forget everything.
10. **Store** tokens in the Keychain (or the platform's equivalent), never log them, show the host the person is signed in to, and sign in to one Gateway per account.

## What a token opens

|           | What                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where     | Only `{origin}`. Sent to another app host or to `/mcp` it is refused (the audience is checked).                                                                                                                                                                                                                                                                                                           |
| As whom   | The member who consented, in that organization. Every request re-checks their membership, role, app access and the connection.                                                                                                                                                                                                                                                                            |
| Scope     | `*` on that app; there is no read-only native grant.                                                                                                                                                                                                                                                                                                                                                      |
| Lifetimes | Access token 1 hour; refresh token 30 days, sliding, rotated on use.                                                                                                                                                                                                                                                                                                                                      |
| Ends      | The person revokes it (account menu → AI connections → "Apps on your devices" → Sign out), the app signs out, the member is removed or deactivated, the app is deleted or disabled, or 30 days pass unused: each takes effect on the next request. Signing in again from the same installation (same client and redirect URI, the loopback port not counting) to the same app replaces the earlier grant. |

The discovery document is served (GET and HEAD) only while `MCP_OAUTH_ENABLED` is on, and only for an active app; an inactive app's host answers its usual 503. An app host's 401 challenge carries `resource_metadata` pointing at it, so a client that starts from a 401 can discover from there. Only first-party app hosts (`<app>.<base>`) are resources; a hosted third-party host refuses native tokens. `MCP_OAUTH_ENABLED` and `MCP_DCR_ENABLED` switch native sign-in along with MCP's OAuth ([MCP](/docs/agent/mcp)).

## Behind Cloudflare Access

The person passes Access's login in the browser at step 5; `/oauth/token` and `/oauth/register` are bypassed already. The app host lets through only the manifest's `bearerRoutes` and the discovery document; anything else answers with an HTML login page, so a native app that gets HTML should tell the person to ask the operator to add the path to `bearerRoutes`. With Managed OAuth on, `/oauth/token` is behind Access and native sign-in doesn't work. Details: [Cloudflare Access](/docs/agent/access#native-apps).

## Threats, briefly

- A typed URL can be anyone's: the app talks only to that origin and the issuer it names, the person signs in on that site's page in their own browser, and the app shows the host.
- Another local process on the callback port gets a code it can't redeem without the PKCE verifier.
- Custom URL schemes (`openzen://`) are refused; iOS uses a claimed https link.
- A stolen access token is one app, one member, one hour; revoke from Settings.

The full table is section 10 of `docs/design/native-sign-in.md`; the invariants are in the threat model ([/docs/agent/repo/threat-model](/docs/agent/repo/threat-model)).
