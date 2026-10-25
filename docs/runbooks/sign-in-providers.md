# Sign-in providers: Continue with Google, Microsoft, GitHub, Apple, Cloudflare or your SSO

People can sign in to your gateway with an account they already have,
beside their password: "Continue with Google" on the sign-in page, and the
same for Microsoft, GitHub, Apple, Cloudflare and any OpenID Connect
issuer (Okta, Entra ID, Keycloak, Auth0, Google Workspace as an issuer…).
It is one more way to sign in, not a second login system: Better Auth
stays the system of record for users, sessions, organizations, roles,
invitations, personal access tokens and the OAuth server MCP clients use,
and a provider sign-in ends in an ordinary Better Auth session.

```
person ──► Google (Microsoft, GitHub, Apple, Cloudflare, your IdP) ──► gateway:
           authenticates them, hands back a         verifies the provider's
           code; the gateway redeems it with         answer, applies the
           its client secret (state + PKCE)          membership rules, creates
                                                     a Better Auth session
                                                           │
                                  same as a password sign-in from here on
                                                           ▼
                           perimeter · identity JWT to apps · MCP OAuth · personal tokens
```

All settings are Worker secrets (`<ID>_SIGNIN_<FIELD>`). None can be
changed from the admin UI or over an agent connection, so a stolen admin
session can't add a way in. `everyapp signin add <id>` sets them under
your Cloudflare login.

## Who gets in

A provider only says who someone is: an email it verified. Whether they
are a member is still the gateway's decision, and the invitation flow's
rules hold:

- **A member** signs in. A deactivated member doesn't, whatever the
  provider says.
- **Someone with a pending invitation** for that exact email joins with
  the invited role and the organization's "Available to everyone" apps,
  like accepting the invite link. They don't need the link or a password.
- **Everyone else** is refused ("You don't have an account on this
  gateway. Ask an admin to invite you."), and nothing is created for them.
  There is no auto-join by email domain for sign-in providers (Cloudflare
  Access keeps its own, `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`); see
  TODO.md, "Sign-in providers (2026-10-25)".
- **An unverified email** signs nobody in and creates nothing, invited or
  not: Google's and Apple's `email_verified`, GitHub's verified primary
  address, the issuer's `email_verified`, and for Microsoft the rule below.
- **Nobody** signs in with a provider until the gateway has been claimed
  with its setup link: the first owner is still made by `everyapp setup`.
- On the hosted gateway, whose sign-up is open, anyone with a verified
  email gets an account and a personal organization, as the sign-up form
  gives.

### Existing accounts

Accounts are keyed by the provider's stable subject (Google's `sub`,
GitHub's id, Entra's `oid`, Apple's `sub`, Cloudflare's user id), so a
person whose address changes at the provider keeps their account.

A provider identity is linked to an existing account with the same email
only when the provider reports the email verified **and** that account's
own email is verified (Better Auth's rule for a provider that isn't
trusted by name; none of these are). Accounts created with a password,
the owner's from the setup link included, aren't verified: someone who
registered with another person's address must never get that person's
account. Each such account connects once, while signed in:

- "Continue with Google" says an account already exists; sign in with the
  password, and the page connects Google. Or, signed in, use **Connect
  Google** in the account menu.
- After that, Google alone signs them in, and the first such sign-in
  marks the account's email verified.

People who join through a provider never get a password; they can set one
with "Forgot password" if the gateway sends email.

## Set up a provider

Every provider follows the same four steps. The redirect URL (also called
the callback or return URL) is always
`https://<gateway>/api/auth/callback/<id>`: for a gateway at
`apps.acme.com` and Google, `https://apps.acme.com/api/auth/callback/google`.
`everyapp signin show <id>` prints it, and Manage workspace → Sign-in shows
it next to each provider that needs setup.

1. Create the OAuth app at the provider's console, with that redirect URL.
2. `pnpm everyapp signin add <id>`: it asks for the client id (shown as
   typed) and the client secret (hidden), and any other setting the
   provider has; `--client-id`, `--client-secret-from-env VAR` and the
   provider's flags do it unattended. The settings go on the gateway Worker
   as secrets, live on the next request.
3. Open the sign-in page: the button is there. Sign in with an invited
   address to check.
4. Behind the Cloudflare Access outer ring (`everyapp access on`), nothing
   changes: a provider sign-in makes a session only for the person Access
   vouches for on the request, so claim and invite with the addresses
   Access knows people by.

`pnpm everyapp signin list` shows each provider as on, needs setup
(some of its settings are missing: the gateway keeps it off rather than
half-configured, and the log says what is missing) or off. `pnpm everyapp
signin remove <id>` deletes its settings; people who signed in with it
keep their accounts and can use another way in.

The step-by-step guides an agent can follow are the everyapp skill's
`setup/signin-google.md`, `setup/signin-microsoft.md`, `setup/signin-github.md`,
`setup/signin-apple.md`, `setup/signin-cloudflare.md` and `setup/signin-oidc.md`.

### Google

Google Cloud console → APIs & Services → Credentials → Create credentials
→ OAuth client ID, type Web application, with the redirect URL under
Authorized redirect URIs. Settings: `GOOGLE_SIGNIN_CLIENT_ID` (ends in
`.apps.googleusercontent.com`) and `GOOGLE_SIGNIN_CLIENT_SECRET`. The
consent screen must exist; while it is in Testing only the test users
listed on it can sign in, so publish it. Scopes `openid email profile`.

### Microsoft

Microsoft Entra admin center → App registrations → New registration, a Web
platform with the redirect URL, then Certificates & secrets → New client
secret (it expires, 24 months at most: set a reminder). Settings:
`MICROSOFT_SIGNIN_CLIENT_ID` (the Application (client) ID),
`MICROSOFT_SIGNIN_CLIENT_SECRET`, and `MICROSOFT_SIGNIN_TENANT`.

Which addresses count as verified depends on the tenant setting:

- **Your own directory** (recommended): register the app for "Accounts in
  this organizational directory only" and set `MICROSOFT_SIGNIN_TENANT` to
  the Directory (tenant) ID. Your directory's addresses are trusted as
  Access trusts your identity provider.
- **Any Microsoft account** (`MICROSOFT_SIGNIN_TENANT` unset, or
  `common`, `organizations`, `consumers`): any tenant's admin can put any
  address on their users (Microsoft calls the attack "nOAuth"), so the
  gateway needs the token's own word for the address. Under Token
  configuration add the optional claims `email` and `xms_edov` ("email
  domain owner verified"); a token with `xms_edov: true`,
  `email_verified: true`, a matching `verified_primary_email`, or from a
  personal Microsoft account counts. Without them every sign-in is
  refused as unverified.

Scopes `openid profile email`; the gateway asks for no Graph scope and
keeps no refresh token.

### GitHub

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App (not a
GitHub App), with the redirect URL as the Authorization callback URL, then
Generate a new client secret. Settings: `GITHUB_SIGNIN_CLIENT_ID` and
`GITHUB_SIGNIN_CLIENT_SECRET`. Scopes `read:user user:email`; the email is
the person's primary address, and only when GitHub marks it verified.

### Apple

Apple Developer → Certificates, Identifiers & Profiles: an App ID with
Sign in with Apple, a Services ID (its identifier is the client id) with
the gateway's domain and the redirect URL as a Return URL, and a Key with
Sign in with Apple. The client secret is a JWT you sign with that key
(ES256; `iss` your Team ID, `sub` the Services ID, `aud`
`https://appleid.apple.com`, `exp` at most six months out); the setup
guide has the command. Settings: `APPLE_SIGNIN_CLIENT_ID` and
`APPLE_SIGNIN_CLIENT_SECRET`. **Generate a new secret before the old one
expires** or sign-in stops.

Apple returns to the gateway with a POST (`form_post`), which Better Auth
answers with a redirect to the same URL as a GET. Behind the outer ring,
`everyapp access on` leaves `/api/auth/callback/apple` public for that
POST (it creates nothing; the GET that follows is checked by Access as
usual); a ring made by hand without that bypass blocks Apple sign-in.
Someone who chose Hide My Email arrives as a `@privaterelay.appleid.com`
address, which no invitation names: invite the relay address, or ask them
to share their email.

### Cloudflare

Cloudflare dashboard → Manage Account → OAuth clients → Create client
(Super Administrator, Administrator or the OAuth Client Write role):
authorization code, `client_secret_basic`, the redirect URL, and the
scope User Details Read (`user-details.read`) as required. Settings:
`CLOUDFLARE_SIGNIN_CLIENT_ID` and `CLOUDFLARE_SIGNIN_CLIENT_SECRET`.

**Keep the client private** (the default). A private client can only be
authorized by members of your Cloudflare account, who joined it by
accepting an invitation sent to their address: that is what makes the
address trustworthy, since Cloudflare's `/user` endpoint reports no
verified flag. Making a client public (any Cloudflare user; needs a logo,
a client URL and a DNS `TXT` verification) is permanent and would let
anyone present an unverified address; the gateway can't tell the two
apart. So this is "Sign in with Cloudflare" for the members of your
Cloudflare account; everyone else uses another provider, a password, or
Access's one-time PIN.

#### Sign in with Cloudflare: Access's identity provider versus this

Two different things share the name:

- **Access's "Cloudflare" identity provider** (`everyapp access on`,
  `docs/runbooks/cloudflare-access.md`) is a login *in front of* the
  gateway. Cloudflare Access authenticates the browser on
  `<team>.cloudflareaccess.com` with the person's Cloudflare account (or
  the one-time PIN, or your IdP) before any request reaches the gateway,
  and the gateway signs them in from the assertion Access adds. It
  protects every page and app behind it, costs a Zero Trust seat per
  person, and is where MFA and device rules live.
- **The `cloudflare` sign-in provider** (this page) is a button *on* the
  gateway's sign-in page, through a Cloudflare OAuth client you create in
  your account (self-service since 2026; private clients are limited to
  your account's members). Nothing sits in front of the gateway; it is a
  social login like Google's, for people who already have a Cloudflare
  account in yours.

Both can be on at once. With the outer ring on, the button is rarely
needed: Access has already signed the person in. Without Access, it is the
quickest way for your Cloudflare account's members to get in with no
password.

### Any OpenID Connect issuer (`oidc`)

For Okta, Entra ID as an issuer, Keycloak, Auth0, Google Workspace as an
issuer, Authentik and the like: create an OpenID Connect client (web
application, authorization code, with the redirect URL). Settings:
`OIDC_SIGNIN_ISSUER` (the issuer URL, `https://…`, which serves
`/.well-known/openid-configuration`; the document must name the same
issuer), `OIDC_SIGNIN_CLIENT_ID`, `OIDC_SIGNIN_CLIENT_SECRET`, and
optionally `OIDC_SIGNIN_LABEL` (the button text after "Continue with";
default "SSO"). Scopes `openid email profile`; the email is the ID
token's, else the userinfo endpoint's, and only with `email_verified:
true`. ID tokens must be signed with RS256 (every major issuer's default)
and carry the nonce the sign-in started with.

Discovery is fetched when someone starts a sign-in (and cached for an
hour), never when the gateway starts; an issuer that is down answers the
sign-in with `SIGNIN_PROVIDER_UNAVAILABLE` and the next attempt tries
again. Cloudflare Access for SaaS is also an OIDC issuer, but has its own
settings (`CLOUDFLARE_ACCESS_OIDC_*`, the Access runbook); use those for
Access and `OIDC_SIGNIN_*` for everything else.

## Turning passwords off

`EMAIL_PASSWORD_SIGN_IN=false` closes password sign-in, sign-up and
resets over HTTP. It takes effect only while an Access sign-in method or a
sign-in provider is on **and** some owner has connected such an identity,
so it can't lock the owner out: connect first (the account menu), then
set it. `true` turns passwords back on.

## Taking someone off: Deactivate

Deactivate them in Every App (Manage workspace → Users → ⋯ →
Deactivate). That signs them out everywhere and revokes their personal
access tokens and AI connections, whatever the provider says; their next
"Continue with Google" is refused. Removing them at the provider (the
Google Workspace account, the GitHub organization) stops new sign-ins
there but not the sessions and tokens they hold.

## Troubleshooting

- **The button isn't on the sign-in page.** The provider isn't on: a
  setting is missing or malformed (`pnpm everyapp signin list` says which;
  the gateway log has `signin.config_problem`), or the new Worker version
  isn't live yet.
- **"redirect_uri_mismatch"** (or the provider's equivalent). The OAuth
  app's redirect URL isn't exactly
  `https://<gateway>/api/auth/callback/<id>`; `signin show <id>` prints it.
- **"You don't have an account on this gateway."** The address the
  provider returned isn't a member's and has no pending invitation. Invite
  it (exactly as the provider spells it), or ask the person to sign in
  with the account the provider knows them by.
- **"The sign-in provider hasn't verified this email address."** Google
  or GitHub reports the address unverified; for Microsoft on `common`,
  the optional claims aren't configured (above); for an OIDC issuer, the
  ID token lacks `email_verified: true`.
- **"An account with this email already exists."** Sign in with the
  password once; the page connects the provider. Or ask an admin whether
  the account's email is verified.
- **"The sign-in provider couldn't be reached."** The OIDC issuer's
  discovery document couldn't be fetched, or names another issuer than
  `OIDC_SIGNIN_ISSUER`.
- **Apple stops working after a few months.** The client secret JWT
  expired; generate a new one and `signin add apple` again.
- **Behind Access: "Cloudflare Access knows you by another email".** The
  provider's address isn't the one Access asserts for this browser.
  Claim and invite with the addresses Access knows people by.

## What the gateway checks

For the auditor: the register is `docs/threat-model.md`, B10. In short:
every flow runs through Better Auth's state and PKCE and redeems the code
with the client secret; the generic OIDC ID token is verified in full
(RS256 by the issuer's JWKS with a fail-closed cache, issuer, audience,
expiry, nonce) and a userinfo answer counts only for the same `sub`; no
provider accepts a posted ID token; only identity scopes are asked for
and no refresh token is kept; the settings are a name family no app
manifest or provider row can take; and behind the outer ring a session is
only ever made for the person Access vouches for.
