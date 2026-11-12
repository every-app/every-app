---
title: "Native apps: Sign in with Every App"
description: "How a Mac or phone app signs a person in to one EveryApp app through the Gateway's OAuth server: bearer routes (`public` entries with `bearer: true`), the client contract (discovery, registration, loopback redirect, PKCE, resource, refresh, sign-out), and Cloudflare Access."
---

A native app (a Mac recorder, a phone client) signs the person in through the Gateway's sign-in page in the system browser and gets a token that opens **one app, as that member, and nothing else**. It's an OAuth client of the Gateway like an AI client, except its `resource` is the app's origin (`https://notes.apps.example.com`) instead of `/mcp`. No password or cookie reaches it. The person's page is [/docs/native-sign-in](/docs/native-sign-in).

## The app's side

```ts
// everyapp.config.ts
public: [{ path: "/api/**", bearer: true }],
```

A bearer route takes a token on every method (so no `methods`) and refuses the session cookie, so keep the web UI's calls elsewhere. Behind Cloudflare Access, `access on` lets these paths and `/.well-known/oauth-protected-resource` through Access on the app's host; `deploy` updates Access when it adds a bearer route. In the handler a native caller is an ordinary member with `channel: "api"`, `actor.sub` `oauth:<connection id>` and `scopes: ["*"]`.

## The client contract

`{origin}` is the app's URL, `{gateway}` the Gateway's.

1. Ask for the app's URL; keep the origin; require https.
2. Discover: `GET {origin}/.well-known/oauth-protected-resource` gives `resource` (must equal `{origin}`) and `authorization_servers[0]`. Then `GET {gateway}/.well-known/oauth-authorization-server` gives the endpoints.
3. Be a client: register once per install at `registration_endpoint` (`client_name`, `redirect_uris: ["http://127.0.0.1/callback"]`, `grant_types: ["authorization_code", "refresh_token"]`, `token_endpoint_auth_method: "none"`), keeping `client_id`. Or publish a Client ID Metadata Document and use its URL as `client_id`. Registration lapses after 60 days unused (`invalid_client`: register again).
4. Listen on a free port on `127.0.0.1`, path `/callback`.
5. Open the system browser (never a web view) at `{authorization_endpoint}?response_type=code&client_id=…&redirect_uri=http://127.0.0.1:{port}/callback&code_challenge={S256}&code_challenge_method=S256&state={random}&resource={origin}`. No `scope`. The person signs in and allows.
6. On the callback, check `state` and `iss`, then `POST {token_endpoint}` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier` and `resource={origin}`. That returns an access token (1 hour) and a refresh token. `invalid_target` means the Gateway has no such app.
7. Call `{origin}/…` with `Authorization: Bearer {access_token}`.
8. Refresh with `grant_type=refresh_token&refresh_token=…&client_id=…&resource={origin}`. Store the new refresh token at once (rotation). `invalid_grant` means sign in again.
9. Sign out: `POST {revocation_endpoint}` with the refresh token.
10. Keep tokens in the Keychain, never log them, and show which host the person is signed in to.

## What a token opens

Only `{origin}`; another app host or `/mcp` refuses it. It acts as the member who consented, re-checked on every request. Scope `*`; there's no read-only native grant. The grant ends when the person revokes it (Your connections → Apps on your devices), the app signs out, the member is removed, the app is deleted, or 30 days pass unused. `MCP_OAUTH_ENABLED` and `MCP_DCR_ENABLED` switch native sign-in along with MCP's OAuth.

## Behind Cloudflare Access

The person passes Access's login in the browser at step 5; the token and registration endpoints are let through already. On the app's host only its bearer routes, its other public routes and the discovery document are let through, so a native app that gets HTML back should tell the person to ask the operator to add the path as a bearer route (and run `access on`).

In development, `everyapp dev`'s stub mode treats any bearer as the dev user. Test real tokens against a deployed Gateway.
