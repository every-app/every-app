# Use Cloudflare Access to sign in

Cloudflare Access can be how people sign in to your gateway: their own
Cloudflare account ("Sign in with Cloudflare", for the members of your
Cloudflare account), Access's one-time PIN (a code emailed to everyone else),
your company's identity provider, Access's MFA and device rules. It is one
more way to sign in, not a second login system. Better Auth stays the system
of record for users, sessions, organizations, roles, invitations, personal
access tokens and the OAuth server that MCP clients use. An Access sign-in
ends in an ordinary Better Auth session, so everything after it works the
same as after a password: the perimeter, the identity tokens apps get, app
access, `/mcp` and its OAuth, personal tokens, deactivation.

```
person ──► Cloudflare Access ──► gateway: verifies Access's signed token,
           (your IdP, PIN,         applies membership rules, creates a
            MFA, policies)         Better Auth session
                                        │
                     same as a password sign-in from here on
                                        ▼
            perimeter · identity JWT to apps · MCP OAuth · personal tokens
```

All settings are Worker secrets. None can be changed from the admin UI, so a
stolen admin session can't add a way in or change who it lets in.

See also `docs/runbooks/sign-in-providers.md`: "Continue with Google"
(Microsoft, GitHub, Apple, Cloudflare, or any OpenID Connect issuer) on the
gateway's own sign-in page, with or without Access in front. Access protects
everything behind it; a sign-in provider is only one more button on the
sign-in page.

## Two ways, and which to use

|                      | OIDC sign-in                                    | Outer ring (recommended)                                                        |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| What people see      | "Continue with Company SSO" on the sign-in page | Access's login before they reach the gateway at all, then no second login       |
| What Access protects | The sign-in                                     | Every request to the gateway's and apps' hostnames, except the paths you bypass |
| Access app type      | Access for SaaS (OIDC)                          | Self-hosted, hostname-based                                                     |
| MCP clients, the CLI | Unaffected                                      | Through Access too with Managed OAuth (below), or the bypass paths below        |
| Passwords            | Can stay on, or be turned off                   | Can stay on, or be turned off                                                   |
| Set up with          | The cf commands below                           | `pnpm everyapp access on` (or the cf commands below)                            |

Use the **outer ring**: `pnpm everyapp access on` sets it up, and nothing
reaches the gateway or an app without passing Access first. **OIDC sign-in**
suits a team that wants Access only as a button on the sign-in page. Both
can be on at once.

## Who gets in

The same rules apply to both ways. Access only says who someone is (a
verified email). Whether they are a member is still the gateway's decision:

- **A member** signs in. A deactivated member doesn't, whatever Access says.
- **Someone with a pending invitation** for that email joins with the
  invited role and the organization's "Available to everyone" apps, like
  accepting the invite link. They don't need the link or a password.
- **Someone whose email domain is in `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`**
  joins the owner's organization as a member with the apps marked "Available
  to everyone", as if they had accepted an invitation; an admin grants
  others. The domain must match exactly (`acme.com` doesn't let in
  `eng.acme.com` or `notacme.com`).
- **Through the outer ring only**, with
  `CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN=everyone`: anyone your Access policy
  lets in joins the same way. Your Access policy then decides who may join;
  taking someone off still means deactivating them (below).
- **Everyone else** is refused, and nothing is created for them.
- **Nobody** signs in with Access, and no account is created, until the
  gateway has been claimed with its setup link.

### Taking someone off: Deactivate, not Delete

Deactivate them in EveryApp (**Admin → Users → ⋯ → Deactivate**). That
signs them out everywhere at once and revokes their personal access tokens
and AI app connections, whatever Access says. Deploying is another matter:
it takes the Cloudflare login, not a gateway account, so someone who still
holds that login or an API token for the account can deploy until you
revoke it in Cloudflare (`docs/security-model.md`, "Operator Authority").

Taking them out of your Access policy isn't enough on its own. It stops new
Access sign-ins, and behind the outer ring their browser loses the gateway
once their current Access session runs out (the application's session
duration: 720 hours unless you set another): the gateway honours a session
only with Access's word for that person on the request. But personal access
tokens and AI connections never pass through Access, and keep working until
you deactivate them; the exception is an AI app connected through Access
itself ("MCP through Access too", below), which stops within the access
token lifetime. (Revoking their Access session in Zero Trust → My Team →
Users stops their browser at Access's edge sooner.)

With auto-join (`CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`, or the outer ring's
`everyone`), **Delete** wouldn't keep anyone out: their next Access sign-in
would make a new account and join again. For people auto-join covers, Delete
deactivates instead (and says so), so they stay listed and can be
reactivated.

### Existing accounts

An Access identity is linked to an existing account with the same email only
when that account's own email is verified (Better Auth 1.7's rule for trusted
providers). Accounts created with a password, including the owner's from the
setup link, aren't verified: someone who registered with another person's
address must never get that person's account. Each such account connects
once, while signed in:

- **Outer ring:** sign in with the password once, through Access. The
  gateway sees the same email on both sides and links them.
- **OIDC:** "Continue with Company SSO" says an account already exists; sign
  in with the password there and the page connects Access. Or, signed in,
  use **Connect Company SSO** in the account menu.

After that, Access alone signs them in. New people who join through Access
never get a password.

**Use the addresses Access knows people by.** Behind the outer ring, a
browser can only be signed in as the person Access says it is. An account
whose email isn't the one Access asserts can't be used there at all, the
owner's included: its password sign-in is refused ("You're signed in to
Cloudflare Access as ben@acme.com, but this account is owner@acme.com").
So claim the gateway, and invite people, with the email addresses your
identity provider (or the one-time PIN) gives Access. Sign in with Cloudflare
asserts the person's Cloudflare account email: an operator whose gateway
account has another address uses the emailed code, or invites the Cloudflare
one (`everyapp access on` warns, `ACCESS_LOGIN_NOT_MEMBER`). To fix an
account afterwards, see "Access says you're someone else" under
Troubleshooting.

### Verified emails

Access issues a token only after the person authenticated with one of your
team's identity providers, and the gateway treats that email as verified. A
token that says `email_verified: false` is refused. Enable only identity
providers in Access that verify email addresses: one-time PIN, Sign in with
Cloudflare with **Restrict to account members** on, Google Workspace, Okta,
Microsoft Entra ID and the like. A generic OIDC provider that lets users
choose their own email would let them choose someone else's. Keep Restrict
to account members on: with it off, Cloudflare says "any Cloudflare user can
authenticate (subject to your Access policies)" and nothing about whether the
address it asserts was verified, so someone who registers a Cloudflare
account under a member's address could sign in as that member; `everyapp
access on` and `show` warn when it is off (`ACCESS_IDP_ANY_CLOUDFLARE_ACCOUNT`).

To make the gateway hold the line itself, pin the identity providers whose
tokens count: `pnpm everyapp secret set CLOUDFLARE_ACCESS_IDP_IDS` with the
providers' ids, comma separated (`everyapp access show` lists each allowed
provider with its id; Zero Trust → Settings → Authentication shows them
too). With the list set, an assertion or an OIDC ID token from any other
provider is refused, and so is one that names no provider at all
(`access.idp_refused` in the logs, reason `not_listed` or `no_idp_claim`).
Unset, any provider the Access policy let through counts, as before. A
token that carries `email_verified` with anything but `true` is refused
either way.

This "Sign in with Cloudflare" is Access's identity provider, a login in
front of the gateway. The gateway also has a `cloudflare` sign-in provider
of its own: a Continue with Cloudflare button on its sign-in page, through a
private Cloudflare OAuth client in your account
(`pnpm everyapp signin add cloudflare`), with nothing in front of the
gateway and no Zero Trust seat. Both can be on;
`docs/runbooks/sign-in-providers.md`, "Sign in with Cloudflare: Access's
identity provider versus this", compares them.

## Costs and limits

- **Seats.** Every person who signs in through Access uses a Zero Trust seat.
  The Free plan covers up to 50 users and blocks the 51st; beyond that
  Access is paid per user (pay-as-you-go is $7 per user per month, billed
  annually). Paths you bypass and service tokens use no seats.
- **Zero Trust onboarding** may ask for payment details even for the Free
  plan.
- **Login domain.** Access's login page is `<team>.cloudflareaccess.com`; you
  don't need a domain of your own for it.
- **WebSockets.** Access attached to a Worker ("Protect this Worker", Worker
  destinations) answers WebSocket upgrades with 403, which breaks apps that
  sync over WebSockets. For the outer ring, use a hostname-based application
  as below.
- **No `ctx.access`.** The gateway serves static assets, so Cloudflare doesn't
  hand it `ctx.access`; it verifies `Cf-Access-Jwt-Assertion` itself, which
  is why it needs your team domain and the application's AUD tag.

## Set up once: a Zero Trust organization and a way to log in

For the outer ring, `pnpm everyapp access on` does all of this (next
section). For OIDC sign-in, or by hand, with the `cf` CLI (beta; these
commands were checked against `cf@1.0.0-beta.14`). `cf auth login` asks for
Access permissions by default.

```sh
npx cf@1.0.0-beta.14 auth login
export CLOUDFLARE_ACCOUNT_ID=<your account id>   # else cf asks

# Is there an organization (team) already?
npx cf@1.0.0-beta.14 zero-trust organization get

# If not, create one. The team domain is permanent once used.
npx cf@1.0.0-beta.14 zero-trust organization create \
  --name "Acme" --auth-domain acme.cloudflareaccess.com

# An organization made in the dashboard comes with "Sign in with Cloudflare"
# (type cloudflare, restricted to your account's members); one made here
# comes with no provider at all (checked 2026-10-24). Keep both: the
# Cloudflare account for your account's members, the one-time PIN so
# everyone else can log in with their email.
npx cf@1.0.0-beta.14 zero-trust identity-providers create \
  --body '{"name":"Cloudflare","type":"cloudflare","config":{"restrict_to_account_members":true}}'
npx cf@1.0.0-beta.14 zero-trust identity-providers create \
  --body '{"name":"One-time PIN","type":"onetimepin","config":{}}'

# Who may use EveryApp (here: anyone at acme.com). Note its id.
npx cf@1.0.0-beta.14 zero-trust access policies create \
  --name "EveryApp users" --decision allow \
  --include '[{"email_domain":{"domain":"acme.com"}}]'
```

In the dashboard: **Zero Trust** (pick a team name and plan on first visit;
the Cloudflare provider comes with it) → **Integrations → Identity providers
→ Add new → One-time PIN**, and **Access controls → Policies → Add a policy**
for the people who may use EveryApp.

## OIDC sign-in

### 1. Create the Access for SaaS application

Its redirect URL is your gateway's Better Auth callback:
`https://<gateway>/api/auth/callback/cloudflare-access` (for a gateway at
`apps.acme.com`: `https://apps.acme.com/api/auth/callback/cloudflare-access`).
The gateway sends PKCE (S256) and authenticates with the client secret.

```sh
npx cf@1.0.0-beta.14 zero-trust access applications create --body '{
  "name": "EveryApp",
  "type": "saas",
  "saas_app": {
    "auth_type": "oidc",
    "redirect_uris": ["https://apps.acme.com/api/auth/callback/cloudflare-access"],
    "grant_types": ["authorization_code_with_pkce"],
    "scopes": ["openid", "email", "profile"]
  },
  "policies": ["<policy id>"]
}'
```

The response holds `saas_app.client_id` and `saas_app.client_secret` (shown
only here). The issuer is
`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`.

In the dashboard: **Access controls → Applications → Create new application
→ SaaS application**, type a name (EveryApp) and select it, choose
**OIDC**, add the redirect URL, keep the `openid`, `email` and `profile`
scopes, turn on **Proof of Key Exchange (PKCE)**, attach your policy and
identity providers, and copy the **Client ID**, **Client secret** and
**Issuer**.

### 2. Give them to the gateway

```sh
everyapp secret set CLOUDFLARE_ACCESS_OIDC_ISSUER
# https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>
everyapp secret set CLOUDFLARE_ACCESS_OIDC_CLIENT_ID
everyapp secret set CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET
# Optional: the button's label (default "Cloudflare Access")
everyapp secret set CLOUDFLARE_ACCESS_OIDC_LABEL
# Company SSO
```

The sign-in page now shows **Continue with Company SSO**. Secrets survive every deploy of the gateway (`everyapp setup`, `everyapp update`, and the rebinds of `everyapp deploy`).

The issuer must be on your team domain and end in the client id; anything
else turns OIDC sign-in off and logs `access.config_problem`.

## Outer ring

### One command

```sh
pnpm everyapp access on
```

With your Cloudflare login it does the rest of this section, and nothing it
doesn't need to: it finds or creates the Zero Trust team (asking for its
name, which is permanent; `--team <name>` unattended; an account that never
opened Zero Trust needs no dashboard step first), keeps both ways to sign in
(Sign in with Cloudflare, created restricted to your account's members when
the team has none, and the one-time PIN, created when none), keeps the
reusable policy **Every App gateway members** with every member's and
pending invitee's email (plus `--email` and `--email-domain`, never removing
anyone), puts the two applications below in front of the gateway's host and
`*.<app base domain>` with the bypass paths of the table and each app's
public routes (and `/mcp` where its manifest sets `mcp`, its `bearerRoutes`
where it sets them) as path overrides,
and sets the three gateway settings in one new version of the Worker. New
applications get a 720-hour session (`--session` for another), the HttpOnly
and binding cookies, and the two sign-in methods the command vouches for
(the one-time PIN and a Cloudflare provider restricted to the account's
members; the team's other providers, your company login say, are yours to
allow on the applications in the dashboard, and the command never takes one
off); an existing application gains those two and never loses one, so
applications made before Sign in with Cloudflare get it on the next run. The
PIN is created again whenever the team lacks it: a team meant to sign in
with an MFA provider alone gets it back on every run. With more than one
provider Access shows a chooser page first. The team's global session is
left alone unless you pass `--team-session`; it applies to every Access
application in the account. `everyapp setup` runs this command by default
once the owner exists: offered at a terminal (Yes by default), done without
a question with `--yes` or `--json` when the account can (a Zero Trust team
exists, and the Cloudflare login is an owner or admin of the gateway), else
a warning says why and names it; `setup --no-access` leaves Access off, and
`everyapp access off` takes it off later.

Run it again any time: after inviting someone (so Access lets them in), or
after a change by hand. It changes only what differs and reports "as it
should be" otherwise; `everyapp deploy` and `everyapp delete` keep an app's
public routes in step on their own, and `everyapp update` (and `setup` on a
live gateway) brings both applications in line with what the new release
lets through right after the upload (its bypass paths, the sign-in methods;
never the three settings), as the step `gateway.access`, so a release that
moves a gateway path never leaves the live bypass list behind. Access being
on is read from the live applications, so `access off` stays off; a failure
there is a warning naming `access on`, never a failed update. An application that also covers another
hostname keeps that destination; one with policies of its own is left
alone, with a warning. `pnpm everyapp access show` reports the state and
what `on` would change, and `pnpm everyapp status` says in one line whether
Access is on and in step with the deployed gateway (`drift: …` names what
differs: paths, sign-in methods, a missing application, stale settings; the
problem `ACCESS_DRIFT` under the report names `access on`); `pnpm everyapp access off` removes the three
settings first (one version: the ring stops at once), then deletes the two
applications (`--keep-applications` leaves Access in front with passwords
working), and leaves the team, its providers and the policy.

Then each existing member signs in once with their password through Access
(see "Existing accounts"); the command names who. After that, Access alone
signs them in, and passwords can go ("Turning passwords off").

### By hand

#### 1. Put two hostname-based Access applications in front of the gateway

One for the gateway's own host, one for its apps' hosts (`*.<gateway>`).
The gateway signs people in only with the first one's tokens; the second
one's only vouch for a session on an app host. With a single application
for everything, every app host's Access cookie would also be a gateway
login, safe only as long as that cookie stays out of reach of scripts.

Let through, on each, only the machine endpoints, which check their own
credentials:

| Path                              | Where                                              | Why                                                                     |
| --------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `/mcp`, `/mcp/*`                  | gateway; an app host only when its manifest sets `mcp` | MCP clients, with OAuth or a personal access token; by default an app host serves no MCP |
| `/health`                         | gateway                                            | Uptime monitors: `GET` answers 200 or 503 after a bounded `SELECT 1`, reading no session |
| `/oauth/token`, `/oauth/register` | gateway                                            | The OAuth server's token, revocation and registration                   |
| `/.well-known/*`                  | gateway                                            | OAuth discovery documents                                               |
| `/api/auth/callback/apple`        | gateway                                            | Sign in with Apple's cross-site POST return, which only redirects to the same URL as a GET (`docs/runbooks/sign-in-providers.md`) |
| Each app's public routes          | that app's host                                    | Whatever its `everyapp.config.ts` declares as `public` (not a health check: a monitor sends a personal access token) |
| Each app's `bearerRoutes`, and `/.well-known/oauth-protected-resource` | that app's host, when its manifest sets `bearerRoutes` | Native apps signed in with "Sign in with Every App" (`docs/design/native-sign-in.md`): a Gateway token for that one host, never a cookie (the Gateway refuses one there). Bypassed under Managed OAuth too, but native sign-in needs Managed OAuth off |

With **Managed OAuth** on the gateway's application ("MCP through Access
too", below), the MCP and OAuth rows go: the gateway's application bypasses
`/health` alone, and the apps' application keeps only each app's public
routes. AI apps then pass Access like browsers do. The rows above are for
the setup without it.

Keep everything else behind Access, `/oauth/authorize` and the consent pages
(`/oauth/consent*`) included: those are pages for people, signed in with
the gateway's session. (This guide used to bypass all of `/oauth/*`; narrow
such a bypass to the two paths above. It also bypassed `/api/deploy/*`,
`/api/setup/deploy-token` and `/api/admin/has-owner`: the CLI deploys, and
checks for an owner, by reading and writing the gateway's database, never
through the gateway. Remove those overrides.) Path overrides don't cover subpaths,
so use the `/*` forms; a destination takes at most 25.

On both applications keep the `CF_Authorization` cookie **HttpOnly** (the
default) and turn on the **binding cookie**, so a copied Access cookie is
useless without the browser it was issued to.

```sh
# The gateway's own host: its AUD tag goes in CLOUDFLARE_ACCESS_AUD.
npx cf@1.0.0-beta.14 zero-trust access applications create --body '{
  "name": "Every App gateway",
  "type": "self_hosted",
  "destinations": [
    {"type": "public", "uri": "apps.acme.com", "overrides": [
      {"path_pattern": "/health", "behavior": "public"},
      {"path_pattern": "/mcp", "behavior": "public"},
      {"path_pattern": "/mcp/*", "behavior": "public"},
      {"path_pattern": "/oauth/token", "behavior": "public"},
      {"path_pattern": "/oauth/register", "behavior": "public"},
      {"path_pattern": "/.well-known/*", "behavior": "public"},
      {"path_pattern": "/api/auth/callback/apple", "behavior": "public"}
    ]}
  ],
  "policies": ["<policy id>"],
  "session_duration": "720h",
  "http_only_cookie_attribute": true,
  "enable_binding_cookie": true
}'

# The apps' hosts: its AUD tag goes in CLOUDFLARE_ACCESS_APPS_AUD. The
# wildcard bypasses nothing: an app host serves no MCP unless its manifest
# sets `mcp`, and such an app gets a destination of its own (below).
npx cf@1.0.0-beta.14 zero-trust access applications create --body '{
  "name": "Every App apps",
  "type": "self_hosted",
  "destinations": [
    {"type": "public", "uri": "*.apps.acme.com"}
  ],
  "policies": ["<policy id>"],
  "session_duration": "720h",
  "http_only_cookie_attribute": true,
  "enable_binding_cookie": true
}'
```

Each response's `aud` is that application's AUD tag. For an app's public
routes, add a destination for that app's host to the apps' application, with
its paths as overrides (for example `{"type": "public", "uri":
"crm.apps.acme.com", "overrides": [{"path_pattern": "/hooks/*", "behavior":
"public"}]}`); an app whose manifest sets `mcp: { by, why }` gets one with
`/mcp` and `/mcp/*` first; one with `bearerRoutes` gets
`/.well-known/oauth-protected-resource` and those paths next; then its
public routes. `everyapp access on` and
the sync after a deploy compute the same (`packages/cli/src/lib/access/plan.ts`).
Neither body names `allowed_idps`, so Access allows every identity provider
of the team, Sign in with Cloudflare and the one-time PIN included, and
whatever else the team has; `access on` writes the list explicitly (the PIN
and the restricted Cloudflare provider, plus what the application allowed
already) and reports such an application as `sign-in methods differ` until
it has (with more than one provider, leave `auto_redirect_to_identity` off,
so people get Access's chooser).

In the dashboard: **Access controls → Applications → Create new application
→ Self-hosted**, twice: one with the gateway's hostname, one with
`*.<gateway>`, each with the paths above as **public** (bypass) path
overrides and your policy; under **Advanced settings → Cookie settings**
keep **HttpOnly** on and turn on **Binding cookie**; copy each **Application
Audience (AUD) Tag** from its overview. Don't use **Protect this Worker** on
the Worker's page: Worker-level policies refuse WebSockets.

Already have one application covering both? Either split it as above, or
keep it (its AUD in `CLOUDFLARE_ACCESS_AUD`) with HttpOnly on, knowing any
app host's Access cookie is then a gateway login too.

#### 2. Give the gateway your team domain and the AUD tags

```sh
everyapp secret set CLOUDFLARE_ACCESS_TEAM_DOMAIN
# acme.cloudflareaccess.com
everyapp secret set CLOUDFLARE_ACCESS_APPS_AUD
# the apps application's AUD tag (several: comma separated)
everyapp secret set CLOUDFLARE_ACCESS_AUD
# the gateway application's AUD tag
```

Set `CLOUDFLARE_ACCESS_AUD` last. Each setting is live at once, and the outer
ring starts with it, so the apps' tag must already be there, or app hosts
send people back to sign in until it is. (`everyapp access on` sets all
three in one change, so the order doesn't arise.)

Open the gateway: Access asks who you are, and you land signed in. The
first time, an existing account signs in with its password once (see
"Existing accounts"). If you ever take Access off the gateway's hostnames,
delete `CLOUDFLARE_ACCESS_AUD` first (see "Troubleshooting" for how): with
the outer ring set, no session counts without Access's word for it.

### MCP through Access too (Managed OAuth)

Access has **Managed OAuth** (a beta): a switch on an application that
makes Access itself the OAuth server AI apps talk to. Turn it on for the
gateway's application and nothing on the gateway's host needs a bypass:
Claude, ChatGPT, Claude Code and the rest log in at Access like a browser
does (an AI app must support RFC 8707 resource indicators, which the current
MCP specification requires of clients; an older one is refused at Access's
authorize step), and your Access policy decides who may use them. There is
nothing to run or host; the gateway only takes Access's word for the person
on `/mcp`.

What changes:

- An AI app's request to `/mcp` without a token gets `401 invalid_token`
  from Access, with a `WWW-Authenticate` header that points at Access's own
  discovery documents, which Access serves on your hostname
  (`/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/mcp`; the issuer is
  `https://<team>.cloudflareaccess.com`, with PKCE, dynamic client
  registration and refresh tokens). The gateway's own OAuth server, consent
  page and dynamic registration go idle: no request reaches them. Browsers
  still get Access's login page.
- The gateway sees the same `Cf-Access-Jwt-Assertion` as for a browser and
  serves the call for the person it names, before the `Authorization`
  header is looked at, so the Access token the AI app sends there is never
  taken for one of the gateway's own. Without a verified assertion that
  header is checked like any other and refused (see "An AI app loops on
  401" under "Troubleshooting").
- Someone taken out of the policy loses MCP within the access token
  lifetime, 15 minutes by default: Access re-checks the policy at each
  refresh. Deactivating them in EveryApp still cuts them off at once.
- An AI app connected before the switch gets Access's 401 on its next
  request and connects again, this time through Access. Its old connection
  under **Connected AI apps** is dead weight: disconnect it.

**Turn it on.** First finish the outer ring above (team domain and both AUD
tags): without it the gateway ignores the assertion on `/mcp`, and an AI app
would loop on 401 (see "Troubleshooting"). Then give the gateway's Access
application an `oauth_configuration`. The API replaces the application on
`PUT`, so send every field the `GET` returned and change only the
`overrides` (none) and the new object:

```sh
npx cf@1.0.0-beta.14 zero-trust access applications get <app id>   # start from this

npx cf@1.0.0-beta.14 zero-trust access applications update <app id> --body '{
  "name": "Every App gateway",
  "type": "self_hosted",
  "destinations": [{"type": "public", "uri": "apps.acme.com"}],
  "policies": ["<policy id>"],
  "session_duration": "720h",
  "http_only_cookie_attribute": true,
  "enable_binding_cookie": false,
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": true,
      "allow_any_on_loopback": true,
      "allowed_uris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://chatgpt.com/connector_platform_oauth_redirect"
      ]
    },
    "grant": {
      "session_duration": "168h",
      "access_token_lifetime": "15m"
    }
  }
}'
```

(Plus whatever else your `get` printed, `allowed_idps` say.) Setting up
fresh? Create the gateway's application with this body instead of the one
above: no `overrides`, and `oauth_configuration` from the start. The
`grant` is how long an AI app stays connected before the person logs in at
Access again (`session_duration`, here a week) and how often Access
re-checks the policy meanwhile (`access_token_lifetime`). Claude Code and
Codex register with a redirect on localhost, which the two `allow_any_*`
settings cover; claude.ai and ChatGPT need their callback URLs in
`allowed_uris` (the two above; `https` only, a path may end in `/*`).

In the dashboard: open the gateway's application, remove its path
overrides, and under **Advanced settings** turn on **Managed OAuth** with
**Allow localhost clients**, **Allow loopback clients**, the two callback
URLs under **Allowed redirect URIs**, and a **Grant session duration** and
**Access token lifetime**.

On the apps' application, drop the `/mcp` overrides of the apps that have
them too and keep each app's public routes (`everyapp access on`, and the
sync after a deploy, do this once they see `oauth_configuration.enabled` on
the gateway's application; the gateway's own `/health` stays bypassed). An
opted-in app's `<app>.<gateway>/mcp` is then reachable by browsers only
(the perimeter doesn't take the assertion there yet); AI apps use the
gateway's `/mcp`, which offers every app the member can use. Don't turn
Managed OAuth on for the apps' application.

How the gateway treats an AI app that came through Access:

- The person must have signed in to the gateway through Access in the
  browser once, which links the Access identity to their account (see
  "Existing accounts"). Otherwise the AI app gets `403` with reason
  `not_connected` and that advice. Nothing is created from `/mcp`: no
  account, no membership, whatever the auto-join settings say. It is the
  rule the browser path enforces too: an account someone registered with
  another person's address is never handed to that person.
- It gets read and write access to every app the member can use, like the
  browser, not a connection's chosen apps or a token's one app.
- The organization is the one they belong to. With several, the one their
  browser is in (their most recent live session's active organization);
  if that can't be told, `403 organization_unresolved`, and they open the
  gateway and pick one.
- The audit log (`mcp_tool_calls`) records credential kind `access` and the
  email (the `mcp.tool_call` log line carries the user id, not the email);
  apps see the actor `access:<email>`, as they see `oauth:…` and `pat:…`.
- Nothing appears under **Connected AI apps**: the grant lives at Access.
  End it there (the OAuth revocation endpoint Access's discovery document
  lists) or take the person out of the policy, which stops the AI app at
  the next token refresh; deactivating works as always.

**Personal access tokens** get Access's 401 too: there is no bypass left.
A script should keep working if its request also carries a service token
from a **Service Auth** policy on the gateway's application
(`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, with
`Authorization: Bearer epat_…` as before): a service token's assertion
names no person, so the gateway ignores it and checks the personal token as
usual. This hasn't been checked against a live Managed OAuth application
yet (tell us), and the gateway logs `mcp.access_assertion_ignored` with
reason `invalid` for each such request: it can't tell a service token's
assertion from a forged header. Service tokens use no seats.

A request that carries a person's own Access token instead (say through
`cloudflared access curl`) acts as that person, with every app they can
use: the personal token alongside is ignored, its app and scope with it.

**The binding cookie** hasn't been tried with Managed OAuth, and Cloudflare
documents it as unsuited to non-browser clients. Keep it on for the apps'
application, as in section 1. On the gateway's application the body above
leaves it off, so AI apps connect the first time; an AI app's requests
carry a bearer token and no cookie, so it may well work with it on: once
one has connected, turn it on and see, and tell us either way.

**Going back.** Set `oauth_configuration.enabled` to `false` (or turn
**Managed OAuth** off) and restore the overrides from the table above, on
the apps' application too. Nothing changes in the gateway: it accepts the
assertion on `/mcp` only when a request carries one, and its OAuth server
and personal tokens work as before. AI apps that connected through Access
get the gateway's 401 on their next request and connect again, this time
through the gateway's own OAuth server (a new row under **Connected AI
apps**).

### How the gateway treats the assertion

- It never trusts `Cf-Access-Jwt-Assertion` (or the `CF_Authorization`
  cookie) as such: it verifies the RS256 signature against your team's keys
  (`/cdn-cgi/access/certs`, cached ten minutes, refetched for a new key id at
  most every 30 seconds, a fetch given up after 5 seconds), the issuer, the
  AUD tag and the expiry, and needs an application token (`type: "app"`)
  with an email. Service tokens carry no email and sign nobody in. If the
  keys can't be fetched, nobody is signed in by Access.
- It signs people in only on the gateway's own host (`GATEWAY_URL`), during
  the browser's session check, and only with the gateway application's
  token (`CLOUDFLARE_ACCESS_AUD`). Without a usable `GATEWAY_URL` it signs
  nobody in but keeps vouching: a session still counts only with Access's
  word for the person (the gateway logs `access.config_problem` once).
- On `/mcp` (Managed OAuth, above) a verified assertion is the caller's
  credential: the `Cf-Access-Jwt-Assertion` header only, never the
  `CF_Authorization` cookie (on a bypassed `/mcp` the cookie reaches the
  gateway unverified, and reading it would let a cross-site POST act as the
  person); only the gateway application's AUD, never the apps'; and only for
  an Access identity already linked to an account by a sign-in in the
  browser. Behind Managed OAuth, Access lets a browser's cookie-carrying
  request through with the header added, so there the `Origin` rule every
  `/mcp` request passes is what keeps a page on another site from driving
  tool calls: it is checked before the assertion is verified or anything is
  read for the person, and an origin in `MCP_ALLOWED_ORIGINS` is trusted
  with that (see `docs/runbooks/mcp-oauth.md`). An assertion that doesn't
  verify, or is the apps' application's, is logged
  (`mcp.access_assertion_ignored`) and the request is treated as if it
  carried none: the OAuth token or personal token it may also carry is
  checked as always. A verified one for a person with no account linked
  here answers `403 not_connected` (`mcp.access_caller_refused`), whatever
  else the request carries. Without the outer ring configured, `/mcp` never
  looks at the header.
- A session counts only with a verified assertion for the same person on
  the request: the header Access adds, or the `CF_Authorization` cookie that
  browsers also send on the paths you bypass. That holds wherever a session
  is used: the perimeter on app hosts (an app's `/mcp` included), server
  functions, the OAuth pages, Better Auth's own endpoints. A browser holding
  someone else's session gets the Access user's session instead on the
  gateway; elsewhere the session just isn't used. Personal access tokens
  and OAuth tokens never pass through this.
- So when someone's Access session ends (they were taken out of the
  policy, their session ran out), so does their gateway access in the
  browser, whatever gateway session it still holds. Their tokens are
  another matter: see "Taking someone off".
- Behind the outer ring, sessions are only made for that person: a password
  or OIDC sign-in as anyone else is refused (see "Use the addresses Access
  knows people by").
- Apps never see Access: the perimeter strips every `cf-access-*` header and
  the cookie header before proxying, and apps get only the gateway's
  identity token.
- Signing out of the gateway also signs out of Access
  (`/cdn-cgi/access/logout`); otherwise the outer ring would sign the browser
  straight back in.

### Uptime monitoring

The gateway: `GET https://<gateway>/health` is public and bypassed by
Access. It answers `200 {"status":"ok"}` when the gateway reaches its D1
database within two seconds and `503 {"status":"error","database":"down"}`
otherwise, with `cache-control: no-store`; it reads no session and names no
version, one probe runs at a time per isolate and its answer is reused for
five seconds, and other methods get 405
(`apps/every-app-gateway/src/server/health.ts`). Point the monitor there;
it needs no credential. Other spellings Access lets through (`/HEALTH`) are
a JSON 404 from the gateway, never the control plane. The gateway itself
probes each app's `/__everyapp/health` over its service binding when it
activates the app (`probeApp`, `apps/every-app-gateway/src/server/app-activation.ts`).

One app: its routes are private (the starter's `/health` is a JSON endpoint
behind the gateway, not a public route; a health route needs no `public`
entry), so a monitor sends
`Authorization: Bearer epat_…` with `GET https://<app>.<base>/health` (or
whatever the app serves). Say what that token opens before handing it to a
third-party monitor: everything the app does, as the person it belongs to.
Apps don't scope-check their own routes, and an `mcp:`-only token is `403
token_scope` on every route of a host whose manifest has no `mcp`, so the
token must be **Full access**; make it a dedicated monitoring member who can
open that one app and nothing else, bind the token to that app (Manage
workspace → Tokens → Create access token, one app), and note that its expiry
(90 days by default, a year at most) ends the monitor. Behind the outer ring
the request also needs an Access **service token** (`CF-Access-Client-Id`
and `CF-Access-Client-Secret`) from a Service Auth policy on the "EveryApp
apps" application. Make it a **reusable** policy: a policy added inline from
the application's own page makes `access on` skip that application for good
(`ACCESS_INLINE_POLICIES`), so later public routes never get through. The
service token alone opens nothing (the perimeter still demands the personal
token), but it removes the outer ring for its holder on every app host and
path (Access policies are not path-scoped). This path is **unverified
live**: the apps' application has the binding cookie on, which Cloudflare's
authorization-cookie page says to avoid for non-browser tools, and no
service token has been tried against it. The verified alternative for the
one app you monitor: keep `public: [{ path: "/health" }]` in its manifest
and let the monitor fetch it without a credential.

## Membership settings

```sh
# People with these email domains join as members, with the apps marked
# "Available to everyone".
everyapp secret set CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS
# acme.com, acme.io

# Outer ring only: everyone your Access policy lets in joins.
everyapp secret set CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN
# everyone
```

Invitations work as before. An invited person can also just sign in with
Access using the invited email.

## Turning passwords off

```sh
everyapp secret set EMAIL_PASSWORD_SIGN_IN
# false
```

- It takes effect only while an Access sign-in method is configured **and**
  an owner has connected an Access identity, so it can't lock the owner
  out. Until then passwords stay on, and the logs say why.
- In effect, nobody signs in, signs up or resets a password over HTTP, the
  sign-in pages show only Access, and admins can't hand out reset links.
- Members who never connected Access can't sign in until passwords are back
  on, so have everyone sign in with Access once first.
- The setup claim on a fresh gateway still works.
- To turn passwords back on (say Access is down or misconfigured), set it to
  `true`; it is live at once: `everyapp secret set EMAIL_PASSWORD_SIGN_IN`.

## Test locally

`apps/every-app-gateway/scripts/access-local.mjs` is a mock Access: an OIDC
application with a page to pick the email you log in as, and with
`--proxy-port` an outer ring in front of a `vite dev` gateway: the gateway's
application on the proxy's host and, with `--apps-aud`, a separate one on
app hosts (`<app>.localhost:<proxy port>`), each bypassing the paths above
and setting a `CF_Authorization` cookie as Access does. It doesn't play
Managed OAuth (no 401, no discovery documents of its own); the gateway's
tests cover the assertion on `/mcp`.

```sh
cd apps/every-app-gateway
node scripts/access-local.mjs --port 19410 --proxy-port 19301 --gateway http://localhost:19300 --apps-aud local-apps-aud
```

Copy the printed lines into `.dev.vars` (loopback URLs are accepted only in
`vite dev` builds), apply the migrations, start the gateway on port 19300,
and mint a setup link for the proxy's URL:

```sh
pnpm db:migrate:local
pnpm exec vite dev --port 19300 --strictPort
GATEWAY_URL=http://localhost:19301 pnpm setup-link
```

Browse `http://localhost:19301`: the mock asks who you are, then adds a
signed assertion to every request it doesn't bypass. For OIDC only, leave
out `--proxy-port`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD`
and `CLOUDFLARE_ACCESS_APPS_AUD`, and use the gateway's own URL. If the first `vite dev` after an update stops with "There
is a new version of the pre-bundle", start it again.

The automated tests cover the same ground without a browser:
`src/auth/cloudflare-access/*.test.ts`, and for Managed OAuth
`src/server/mcp-auth/access-mcp.sqlite.test.ts`.

## Troubleshooting

- **No "Continue with" button.** Look for `access.config_problem` in the
  Worker's logs: a missing or malformed setting turns OIDC sign-in off.
- **"Signing in with … didn't finish."** The redirect URL in Access must be
  exactly `https://<gateway>/api/auth/callback/cloudflare-access`, PKCE must
  be on, and the issuer must be the application's. Better Auth logs the
  step that failed (state, code exchange, ID token).
- **"An account with this email already exists."** Sign in with the password
  once to connect Access (see "Existing accounts").
- **Access says you're someone else** ("You're signed in to Cloudflare Access
  as X, but this account is Y"). Behind the outer ring an account's email
  must be the one Access asserts. If Access signed you in as the wrong
  person, use **Not you? Sign out of Access** on the sign-in page (or open
  `/cdn-cgi/access/logout`) and sign in there as Y. If the person is X, an
  admin invites X and deactivates the account Y. If Y is the owner's
  account, change its email to X in the gateway's database, then sign in
  with the password through Access once to connect it:

  ```sh
  npx cf@1.0.0-beta.14 d1 list --name every-app-gateway   # its id
  npx cf@1.0.0-beta.14 d1 query <id> \
    --sql "UPDATE users SET email = 'x@acme.com' WHERE email = 'y@acme.com'"
  ```

  (Deleting `CLOUDFLARE_ACCESS_AUD` turns the outer ring off at once if you
  need in first; Access still guards the hostnames, and passwords work as
  without it. `pnpm everyapp access off --keep-applications` removes the
  three settings in one version; `pnpm everyapp secret unset CLOUDFLARE_ACCESS_AUD`
  deletes just that one. Without a
  checkout at hand, delete it with cf, which uploads a new version without
  the secret, then run `pnpm everyapp setup` from a terminal later: it asks
  before replacing a version it didn't upload.)

  ```sh
  npx cf@1.0.0-beta.14 workers secrets delete CLOUDFLARE_ACCESS_AUD --worker every-app-gateway
  ```

- **"This gateway signs people in through Cloudflare Access, and this
  request didn't come through it."** The outer ring is configured, but the
  request carried no assertion Access signed for one of your AUD tags:
  Access isn't in front of that hostname, the path is bypassed, or the AUD
  tag is wrong. Fix the Access application or the secrets. An application
  recreated in the dashboard has a new AUD tag: `pnpm everyapp access on`
  records what it wrote (in the Gateway's D1, since a Worker's secret
  values can't be read back) and writes the settings again when the
  applications it finds aren't the ones recorded; `pnpm everyapp access
  show` says when they are stale, and `--write-settings` writes them
  regardless.
- **"You don't have an account on this gateway yet."** Invite them, or add
  their domain to `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`.
- **Teammates can't log in at Access at all.** The organization's only
  provider is Sign in with Cloudflare, restricted to your account's members:
  `everyapp access on` adds the one-time PIN beside it, on the applications
  too. An operator who gets Access's forbidden page after Sign in with
  Cloudflare has a Cloudflare account email that isn't a gateway member: use
  the emailed code, or invite that address.
- **The 51st person is blocked by Access.** The Free plan has 50 seats.
- **App sync breaks behind the outer ring (WebSocket 403).** The Access
  application is attached to the Worker; use hostname destinations.
- **Apps keep sending people back to the sign-in page** ("the page you were
  going to sent you back here") behind the outer ring. Their hosts' Access
  application isn't one the gateway knows: put its AUD tag in
  `CLOUDFLARE_ACCESS_APPS_AUD`.
- **MCP clients get an HTML login page.** A bypass path is missing, or
  Managed OAuth isn't on. (Connecting an AI app does show Access's login in
  the browser, at `/oauth/authorize` without Managed OAuth, at Access with
  it: that page is for people.)
- **Someone you took out of the Access policy still uses an AI app or a
  script.** Tokens never pass through Access: deactivate them (see "Taking
  someone off"). With Managed OAuth, an AI app connected through Access
  stops within the access token lifetime; personal tokens still need the
  deactivation.
- **An AI app loops on `401 invalid_token`** behind Managed OAuth. Look at
  the `WWW-Authenticate` header. One naming
  `cloudflare-access-protected-resource` is Access's: the person isn't
  allowed in by your policy or identity provider; they must be able to open
  the gateway in a browser as the same email. One naming
  `oauth-protected-resource` (or `realm="every-app"` with no metadata, when
  `MCP_OAUTH_ENABLED` is off) is the gateway's own: it didn't take the
  assertion and asked for a token of its own, which Access's discovery
  documents shadow. The logs say why. `mcp.access_assertion_ignored` with
  reason `invalid`: a wrong `CLOUDFLARE_ACCESS_AUD` or team domain, or the
  keys couldn't be fetched (`access.jwks_fetch_failed` alongside); with
  reason `audience`: the apps' application is in front of the gateway's
  host. No such line at all: the gateway never looked at the header, because
  the outer ring isn't configured (`CLOUDFLARE_ACCESS_TEAM_DOMAIN`,
  `CLOUDFLARE_ACCESS_AUD`; a malformed value is an `access.config_problem`)
  or the gateway isn't `self_hosted` (an `access.config_problem` says its
  Access settings are ignored).
- **An AI app gets `403 not_connected`** behind Managed OAuth. Access knows
  the person, the gateway doesn't yet: open the gateway in a browser and
  sign in once through Access (an existing password account signs in with
  its password, see "Existing accounts"), then connect the AI app again.
- **A script's personal token gets Access's 401** behind Managed OAuth. Add
  a Service Auth policy to the gateway's application and send the service
  token's `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers with
  the request, alongside the personal token (see "Personal access tokens"
  under "MCP through Access too"; not yet checked against a live Managed
  OAuth application).
- **Connected AI apps shows nothing for an AI app connected through
  Access.** Expected: the grant is Access's, not the gateway's. Revoke it at
  Access, or take the person out of the policy.
