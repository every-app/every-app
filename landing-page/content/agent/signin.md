---
title: Sign-in providers
description: "How a Gateway offers Continue with Google, Microsoft, GitHub, Apple, Cloudflare or any OpenID Connect issuer beside passwords: the settings, the redirect URL, everyapp signin, who gets in, and turning passwords off."
---

A sign-in provider is one more button on the Gateway's sign-in page: "Continue with Google", and the same for Microsoft, GitHub, Apple, Cloudflare and any OpenID Connect issuer (Okta, Keycloak, Auth0, Entra as an issuer). It only says who someone is (a verified email); the Gateway decides whether they get in. The person's page is [/docs/sign-in](/docs/sign-in).

The settings are Gateway Worker secrets named `<ID>_SIGNIN_<FIELD>`. Only the Cloudflare login writes them (`everyapp signin add` or `secret set`): nothing in the Gateway's UI or MCP tools can add a way in. A provider is **on** when every required setting is set, **incomplete** when some are, **off** when none are.

## The providers

| Id | Settings | The OAuth app |
|---|---|---|
| `google` | `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` | OAuth client ID (Web application) in Google Cloud Console |
| `microsoft` | `MICROSOFT_SIGNIN_CLIENT_ID`, `MICROSOFT_SIGNIN_CLIENT_SECRET` (expires), optional `MICROSOFT_SIGNIN_TENANT` | App registration in Entra |
| `github` | `GITHUB_SIGNIN_CLIENT_ID`, `GITHUB_SIGNIN_CLIENT_SECRET` | OAuth App (not a GitHub App) |
| `apple` | `APPLE_SIGNIN_CLIENT_ID`, `APPLE_SIGNIN_CLIENT_SECRET` (a JWT valid six months at most) | Services ID |
| `cloudflare` | `CLOUDFLARE_SIGNIN_CLIENT_ID`, `CLOUDFLARE_SIGNIN_CLIENT_SECRET` | A private OAuth client (Manage Account → OAuth clients), so only the account's members can use it |
| `oidc` | `OIDC_SIGNIN_ISSUER`, `OIDC_SIGNIN_CLIENT_ID`, `OIDC_SIGNIN_CLIENT_SECRET`, optional `OIDC_SIGNIN_LABEL` (default `SSO`) | An OIDC web client at the identity provider |

The redirect URL is always `https://<gateway>/api/auth/callback/<id>`. An email counts only when the provider verifies it. For Microsoft, pin the tenant to the operator's own directory (a GUID) to trust its addresses; on `common` the token must carry `xms_edov`. Apple's callback is a POST, which `access on` lets through Access. Accounts are keyed by the provider's stable id, not the email.

## Setting one up

Guides: [setup/signin-google](/docs/agent/setup/signin-google), [setup/signin-microsoft](/docs/agent/setup/signin-microsoft), [setup/signin-github](/docs/agent/setup/signin-github), [setup/signin-apple](/docs/agent/setup/signin-apple), [setup/signin-cloudflare](/docs/agent/setup/signin-cloudflare), [setup/signin-oidc](/docs/agent/setup/signin-oidc).

1. The person creates the OAuth app at the provider with the redirect URL. Only they can. `everyapp signin show <id> --json` gives the console, what to create and the URL.
2. `everyapp signin add <id>` asks for the client id and the hidden secret. Unattended: `everyapp signin add github --client-id Iv1.0123 --client-secret-from-env GITHUB_SECRET --json`. Other flags: `--issuer` and `--label` (oidc), `--tenant` (microsoft).
3. The person opens the sign-in page and signs in with an invited address.

`everyapp signin list` shows every provider's state; `everyapp signin remove <id>` turns one off (asks; `--yes`). From an AI client, `everyapp_signin_list` and `everyapp_signin_show` read the state; there's no add or remove tool, by design. Manage workspace → Sign-in shows the ways in.

## Who gets in

| Who | Result |
|---|---|
| A member who isn't deactivated | Signs in. |
| A deactivated member | Refused (`SIGNIN_ACCOUNT_DEACTIVATED`). |
| Someone with a pending invitation for that exact email | Joins with the invited role. |
| An email the provider hasn't verified | Refused (`SIGNIN_EMAIL_NOT_VERIFIED`). |
| Everyone else | Refused (`SIGNIN_NOT_INVITED`); there's no domain auto-join for providers. |
| Anyone before the owner claimed the Gateway | Refused (`SIGNIN_NOT_SET_UP`). |

An OIDC issuer that can't be reached is `SIGNIN_PROVIDER_UNAVAILABLE`. The sign-in page explains each refusal in a sentence. On a hosted Gateway with open sign-up, anyone with a verified email gets an account.

An existing password account connects a provider once: the button answers `account_not_linked`, the person signs in with the password, and the page connects it. Or, signed in, they use **Connect <label>** in the account menu. After that the provider alone signs them in.

Behind Cloudflare Access a provider sign-in works only for the person Access vouches for (`ACCESS_EMAIL_MISMATCH`). Access's own "Sign in with Cloudflare" is a different thing: a login in front of the Gateway, set up by `access on`. [access](/docs/agent/access)

## Turning passwords off

`everyapp secret set EMAIL_PASSWORD_SIGN_IN` with `false` closes password sign-in, sign-up and resets (`PASSWORD_SIGN_IN_DISABLED`). It takes effect only while a provider or Access sign-in is on and some owner has connected it, so nobody is locked out. Set it back to `true` to recover.
