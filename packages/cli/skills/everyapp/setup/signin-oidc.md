# Sign in with any OpenID Connect issuer (your SSO) on the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Puts **Continue with SSO** (or a label the person picks, such as
`Continue with Okta`) on the Gateway's sign-in page, beside the password,
through the company's identity provider: Okta, Keycloak, Auth0, Authentik,
Google Workspace as an issuer, and the like. At the end the person has a
web-application client at their identity provider, its settings on the
Gateway, and has signed in through it once.
`pnpm everyapp signin show oidc --json` names this file as `setup`, and the
CLI prints `Guide: .claude/skills/everyapp/setup/signin-oidc.md`.

Who gets in doesn't change: the issuer only says who someone is, and only
an ID token with `email_verified: true` counts. A member signs in;
someone with a pending invitation for that exact address joins with the
invited role; everyone else is refused ("You don't have an account on this
gateway.") and nothing is created. The rules:
`docs/runbooks/sign-in-providers.md`, "Who gets in".

Not this file: Cloudflare Access for SaaS (also an OIDC issuer, but with
its own `CLOUDFLARE_ACCESS_OIDC_*` settings; [access.md](access.md) and
`docs/runbooks/cloudflare-access.md`). Microsoft Entra ID: prefer
[signin-microsoft.md](signin-microsoft.md), which handles Entra's
verified-email rules; Entra's ID tokens carry no `email_verified` claim
(not among its optional claims), so here every sign-in would be refused.

## Settings

| Name                        | Required | Flag                             | What it holds                                                                 |
| --------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `OIDC_SIGNIN_ISSUER`        | required | `--issuer <url>`                 | the issuer URL, `https://…`, which serves `/.well-known/openid-configuration` |
| `OIDC_SIGNIN_CLIENT_ID`     | required | `--client-id <id>`               | the client's ID; not a secret                                                 |
| `OIDC_SIGNIN_CLIENT_SECRET` | required | `--client-secret-from-env <VAR>` | the client's secret                                                           |
| `OIDC_SIGNIN_LABEL`         | optional | `--label <text>`                 | the button text after "Continue with" (default `SSO`; 40 characters at most)  |

Scopes asked for: `openid email profile`. The email is the ID token's,
else the userinfo endpoint's (for the same `sub` only), and counts only
with `email_verified: true`. ID tokens must be signed with RS256 (every
major issuer's default) and carry the sign-in's nonce.

## Costs and plans

Whatever the identity provider charges; the Gateway adds nothing. Most
include OIDC web clients on every plan (Okta, Auth0 and Authentik plans
not checked here: unverified).

## Only a person can

- Sign in to the identity provider's admin console and create the client.
- Assign the people (or groups) who may use it, where the provider asks.
- Copy the client secret off the screen and type it at the hidden prompt
  of `pnpm everyapp signin add oidc`.
- Choose the button's label; sign in through it to check.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true;
   `data.gatewayUrl` gives `<gateway host>`. Not installed or no owner:
   [gateway.md](gateway.md) first. `data.access.on` true: see Verify 4.
2. `pnpm everyapp signin show oidc --json` (changes nothing; `Unknown
   command signin`: `git pull` in the `every-app` folder). `data.status`
   `off`: this file applies; `needs setup`: `data.missing` says what is
   left (step 4); `on`: ask before replacing. `data.callbackUrl` is
   `https://<gateway host>/api/auth/callback/oidc`.
3. Ask which identity provider, and the label they want on the button.

## Steps

1. **You:** give the person `data.callbackUrl`.
2. **Person:** in the identity provider's admin console, create an OpenID
   Connect client: type web application (confidential, with a secret),
   grant **authorization code**, sign-in redirect URI the exact URL from
   step 1, scopes `openid email profile`. Assign it to the people or groups
   who should sign in (Okta and Authentik refuse unassigned users). Note
   the issuer URL the console shows. Usual forms (check each with step 3):
   Okta `https://<org>.okta.com` or `https://<org>.okta.com/oauth2/default`;
   Keycloak `https://<host>/realms/<realm>`; Auth0
   `https://<tenant>.<region>.auth0.com/` (with the slash); Authentik
   `https://<host>/application/o/<slug>/`; Google Workspace
   `https://accounts.google.com` (a Web application client as in
   [signin-google.md](signin-google.md), Internal audience). The page
   shows the client ID and secret; keep it open.
3. **You:** check the issuer, nothing secret in it:
   ```sh
   curl -s https://<issuer host and path>/.well-known/openid-configuration | jq -r .issuer
   ```
   (an issuer ending in `/`: drop that slash before `/.well-known`). The
   answer must equal the issuer URL exactly, trailing slash included; that
   exact string is `--issuer`. HTML, nothing, or another string: the
   wrong URL (Okta's org server and its `default` server are two issuers).
4. **Person:** in a second terminal in the `every-app` folder:
   ```sh
   pnpm everyapp signin add oidc
   ```
   It asks for the issuer and the client ID (shown as typed), the client
   secret (hidden: pasting works, nothing is echoed) and the label (shown
   as typed; Enter leaves the default, `SSO`), and writes them in one new Gateway Worker
   version, live on the next request. They tell you when it's done.
   Another way: in that terminal, the hidden read (bash or zsh:
   `read -rs OIDC_SIGNIN_CLIENT_SECRET && export OIDC_SIGNIN_CLIENT_SECRET`;
   fish: `read -s -x OIDC_SIGNIN_CLIENT_SECRET`), paste, Enter, then
   `pnpm everyapp signin add oidc --issuer <issuer> --client-id <client ID> --label Okta --client-secret-from-env OIDC_SIGNIN_CLIENT_SECRET --json`
   and `unset OIDC_SIGNIN_CLIENT_SECRET` (fish: `set -e OIDC_SIGNIN_CLIENT_SECRET`).

## Verify

1. `pnpm everyapp signin list --json`: the `oidc` entry has `status: "on"`
   and `missing` empty.
2. The person's address at the identity provider must be a member's or
   have a pending invitation: `pnpm everyapp workspace invite <email>`.
3. **Person:** private window, `https://<gateway host>/sign-in` →
   **Continue with <label>** → the identity provider's login → the
   Gateway, signed in. The issuer's discovery document is fetched at this
   moment (and cached for an hour), not when the Gateway starts.
4. Behind Cloudflare Access: nothing else changes, but the identity
   provider's address must be the one Access knows the person by.
5. Logs (README's Verify 4): `signin.config_problem` names a malformed
   setting (an issuer that isn't an https URL, a label too long).

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| no button | a setting missing or malformed, or the version isn't live yet | `pnpm everyapp signin list --json`; logs' `signin.config_problem` |
| `SIGNIN_ISSUER_INVALID` | not an https URL, or it has a query, a fragment or credentials | the bare issuer URL from step 3 |
| `SETTING_VALUE_INVALID` | the label is over 40 characters | a shorter `--label` |
| "The sign-in provider couldn't be reached." (`SIGNIN_PROVIDER_UNAVAILABLE`) | the discovery document couldn't be fetched, or names another issuer than `OIDC_SIGNIN_ISSUER` | step 3; `signin add oidc --issuer <exact issuer> --json` (the rest is kept) |
| the provider's redirect URI error | the client's redirect URI isn't exactly `data.callbackUrl` | fix it at the provider |
| "The sign-in provider hasn't verified this email address." | the ID token lacks `email_verified: true` | the provider marks the user's email verified (Keycloak: the user's **Email verified**; Auth0: verify the email), or another provider |
| sign-in fails after the provider's login, logs mention the token's algorithm | the ID token isn't RS256 | switch the client's signing algorithm to RS256 |
| "You don't have an account on this gateway." | the address isn't a member's or invited | invite it exactly as the provider spells it |
| `SIGNIN_VALUE_REQUIRED` / `SECRET_EMPTY` | unattended, a required setting neither given nor set / the env variable empty in that shell | `data.rerun` with the flags / the hidden read again in the same terminal |

## Rerun, rotate, remove

- Rerun: `pnpm everyapp signin add oidc` any time; values given replace,
  settings not given are kept (Enter at a prompt keeps it).
- Rotate: a new secret at the provider, then `pnpm everyapp signin add oidc`
  with Enter at the other prompts, or the hidden read and
  `pnpm everyapp signin add oidc --client-secret-from-env OIDC_SIGNIN_CLIENT_SECRET --json`.
  Then revoke the old secret there.
- Back to the default label: `pnpm everyapp secret unset OIDC_SIGNIN_LABEL --json`
  (`--yes` only when the person said so).
- Remove, only when asked: `pnpm everyapp signin remove oidc --json --yes`
  (`--yes` only when they said so). Accounts made with it stay. Then
  delete the client at the provider.

## Sources

- https://openid.net/specs/openid-connect-discovery-1_0.html (the
  `/.well-known/openid-configuration` path, a trailing `/` removed first;
  the document's `issuer` must be identical to the issuer URL)
- https://openid.net/specs/openid-connect-core-1_0.html (`email_verified`,
  `nonce`, RS256 as the default ID token algorithm)
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
  (Entra's claims: `email`, `xms_edov`, `verified_primary_email`; no
  `email_verified`)
- The issuer forms in step 2 are the providers' usual ones, not checked
  against each provider's docs today (unverified); step 3 checks the real
  one.
- `docs/runbooks/sign-in-providers.md` ("Any OpenID Connect issuer",
  "Troubleshooting") and `packages/sdk/src/internal/signInProviders.ts`
