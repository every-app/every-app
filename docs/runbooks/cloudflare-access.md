# Use Cloudflare Access to sign in

Cloudflare Access can be how people sign in to your gateway: your company's
identity provider, Access's one-time PIN, its MFA and device rules. It is one
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

## Two ways, and which to use

|                      | OIDC sign-in (recommended)                      | Outer ring                                                                      |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| What people see      | "Continue with Company SSO" on the sign-in page | Access's login before they reach the gateway at all, then no second login       |
| What Access protects | The sign-in                                     | Every request to the gateway's and apps' hostnames, except the paths you bypass |
| Access app type      | Access for SaaS (OIDC)                          | Self-hosted, hostname-based                                                     |
| Mobile app           | Works (sign-in runs in the system browser)      | Not supported: the app's requests carry no Access session                       |
| MCP clients, the CLI | Unaffected                                      | Need the bypass paths below                                                     |
| Passwords            | Can stay on, or be turned off                   | Can stay on, or be turned off                                                   |

Use **OIDC sign-in** unless a security team requires Access in front of
everything. The **outer ring** suits installs where nothing may be reachable
without passing Access first (deny-by-default zones, device posture on every
request). Both can be on at once, though the mobile app then can't sign in.

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

Deactivate them in Every App (**Admin → Users → ⋯ → Deactivate**). That
signs them out everywhere at once and revokes their personal access tokens
and AI app connections, whatever Access says. Deploying is another matter:
it takes the Cloudflare login, not a gateway account, so someone who still
holds that login or an API token for the account can deploy until you
revoke it in Cloudflare (`docs/security-model.md`, "Operator Authority").

Taking them out of your Access policy isn't enough on its own. It stops new
Access sign-ins, and behind the outer ring their browser loses the gateway
once their current Access session runs out (the application's session
duration, 24 hours unless you set another): the gateway honours a session
only with Access's word for that person on the request. But personal access
tokens and AI connections never pass through Access, and keep working until
you deactivate them. (Revoking their Access session in Zero Trust → My Team
→ Users stops their browser at Access's edge sooner.)

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
identity provider (or the one-time PIN) gives Access. To fix an account
afterwards, see "Access says you're someone else" under Troubleshooting.

### Verified emails

Access issues a token only after the person authenticated with one of your
team's identity providers, and the gateway treats that email as verified. A
token that says `email_verified: false` is refused. Enable only identity
providers in Access that verify email addresses: one-time PIN, Google
Workspace, Okta, Microsoft Entra ID and the like. A generic OIDC provider
that lets users choose their own email would let them choose someone else's.

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

With the `cf` CLI (beta; these commands were checked against
`cf@1.0.0-beta.14`). `cf auth login` asks for Access permissions by default.

```sh
npx cf@1.0.0-beta.14 auth login
export CLOUDFLARE_ACCOUNT_ID=<your account id>   # else cf asks

# Is there an organization (team) already?
npx cf@1.0.0-beta.14 zero-trust organization get

# If not, create one. The team domain is permanent once used.
npx cf@1.0.0-beta.14 zero-trust organization create \
  --name "Acme" --auth-domain acme.cloudflareaccess.com

# New organizations let in only members of your Cloudflare account. Add the
# one-time PIN so teammates can log in with their email.
npx cf@1.0.0-beta.14 zero-trust identity-providers create \
  --body '{"name":"One-time PIN","type":"onetimepin","config":{}}'

# Who may use Every App (here: anyone at acme.com). Note its id.
npx cf@1.0.0-beta.14 zero-trust access policies create \
  --name "Every App users" --decision allow \
  --include '[{"email_domain":{"domain":"acme.com"}}]'
```

In the dashboard: **Zero Trust** (pick a team name and plan on first visit) →
**Integrations → Identity providers → Add new → One-time PIN**, and
**Access controls → Policies → Add a policy** for the people who may use
Every App.

## OIDC sign-in

### 1. Create the Access for SaaS application

Its redirect URL is your gateway's Better Auth callback:
`https://<gateway>/api/auth/callback/cloudflare-access` (for a gateway at
`apps.acme.com`: `https://apps.acme.com/api/auth/callback/cloudflare-access`).
The gateway sends PKCE (S256) and authenticates with the client secret.

```sh
npx cf@1.0.0-beta.14 zero-trust access applications create --body '{
  "name": "Every App",
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
→ SaaS application**, type a name (Every App) and select it, choose
**OIDC**, add the redirect URL, keep the `openid`, `email` and `profile`
scopes, turn on **Proof of Key Exchange (PKCE)**, attach your policy and
identity providers, and copy the **Client ID**, **Client secret** and
**Issuer**.

### 2. Give them to the gateway

```sh
everyapp gateway secret set CLOUDFLARE_ACCESS_OIDC_ISSUER
# https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>
everyapp gateway secret set CLOUDFLARE_ACCESS_OIDC_CLIENT_ID
everyapp gateway secret set CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET
# Optional: the button's label (default "Cloudflare Access")
everyapp gateway secret set CLOUDFLARE_ACCESS_OIDC_LABEL
# Company SSO
```

The sign-in page now shows **Continue with Company SSO**, and so does the
mobile app. Secrets survive `everyapp gateway deploy`.

The mobile app runs the sign-in in the system browser and gets its session
from the gateway in exchange for a one-time code and a secret only the app
holds (`/api/auth/mobile-sign-in/*`); the browser never keeps it. Nothing to
configure. (Better Auth Expo's own `/api/auth/expo-authorization-proxy` is
closed: it let any site plant a sign-in it had started in someone else's
browser.)

The issuer must be on your team domain and end in the client id; anything
else turns OIDC sign-in off and logs `access.config_problem`.

## Outer ring

### 1. Put two hostname-based Access applications in front of the gateway

One for the gateway's own host, one for its apps' hosts (`*.<gateway>`).
The gateway signs people in only with the first one's tokens; the second
one's only vouch for a session on an app host. With a single application
for everything, every app host's Access cookie would also be a gateway
login, safe only as long as that cookie stays out of reach of scripts.

Let through, on each, only the machine endpoints, which check their own
credentials:

| Path                              | Where             | Why                                                    |
| --------------------------------- | ----------------- | ------------------------------------------------------ |
| `/mcp`, `/mcp/*`                  | gateway and apps  | MCP clients, with OAuth or a personal access token     |
| `/oauth/token`, `/oauth/register` | gateway           | The OAuth server's token, revocation and registration  |
| `/.well-known/*`                  | gateway           | OAuth discovery documents                              |
| Each app's public routes          | that app's host   | Whatever its `everyapp.config.ts` declares as `public` |

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
      {"path_pattern": "/mcp", "behavior": "public"},
      {"path_pattern": "/mcp/*", "behavior": "public"},
      {"path_pattern": "/oauth/token", "behavior": "public"},
      {"path_pattern": "/oauth/register", "behavior": "public"},
      {"path_pattern": "/.well-known/*", "behavior": "public"}
    ]}
  ],
  "policies": ["<policy id>"],
  "session_duration": "24h",
  "http_only_cookie_attribute": true,
  "enable_binding_cookie": true
}'

# The apps' hosts: its AUD tag goes in CLOUDFLARE_ACCESS_APPS_AUD.
npx cf@1.0.0-beta.14 zero-trust access applications create --body '{
  "name": "Every App apps",
  "type": "self_hosted",
  "destinations": [
    {"type": "public", "uri": "*.apps.acme.com", "overrides": [
      {"path_pattern": "/mcp", "behavior": "public"},
      {"path_pattern": "/mcp/*", "behavior": "public"}
    ]}
  ],
  "policies": ["<policy id>"],
  "session_duration": "24h",
  "http_only_cookie_attribute": true,
  "enable_binding_cookie": true
}'
```

Each response's `aud` is that application's AUD tag. For an app's public
routes, add a destination for that app's host to the apps' application, with
its paths as overrides (for example `{"type": "public", "uri":
"crm.apps.acme.com", "overrides": [{"path_pattern": "/hooks/*", "behavior":
"public"}]}`).

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

### 2. Give the gateway your team domain and the AUD tags

```sh
everyapp gateway secret set CLOUDFLARE_ACCESS_TEAM_DOMAIN
# acme.cloudflareaccess.com
everyapp gateway secret set CLOUDFLARE_ACCESS_APPS_AUD
# the apps application's AUD tag (several: comma separated)
everyapp gateway secret set CLOUDFLARE_ACCESS_AUD
# the gateway application's AUD tag
```

Set `CLOUDFLARE_ACCESS_AUD` last. Each setting is a redeploy, and the outer
ring starts with it, so the apps' tag must already be there, or app hosts
send people back to sign in until it is.

Open the gateway: Access asks who you are, and you land signed in. The
first time, an existing account signs in with its password once (see
"Existing accounts"). If you ever take Access off the gateway's hostnames,
delete `CLOUDFLARE_ACCESS_AUD` first (see "Troubleshooting" for how): with
the outer ring set, no session counts without Access's word for it.

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
  token (`CLOUDFLARE_ACCESS_AUD`).
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

## Membership settings

```sh
# People with these email domains join as members, with the apps marked
# "Available to everyone".
everyapp gateway secret set CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS
# acme.com, acme.io

# Outer ring only: everyone your Access policy lets in joins.
everyapp gateway secret set CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN
# everyone
```

Invitations work as before. An invited person can also just sign in with
Access using the invited email.

## Turning passwords off

```sh
everyapp gateway secret set EMAIL_PASSWORD_SIGN_IN
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
  `true`; it takes effect once the redeploy is live:
  `everyapp gateway secret set EMAIL_PASSWORD_SIGN_IN`.

## Test locally

`apps/every-app-gateway/scripts/access-local.mjs` is a mock Access: an OIDC
application with a page to pick the email you log in as, and with
`--proxy-port` an outer ring in front of a `vite dev` gateway: the gateway's
application on the proxy's host and, with `--apps-aud`, a separate one on
app hosts (`<app>.localhost:<proxy port>`), each bypassing the paths above
and setting a `CF_Authorization` cookie as Access does.

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
`src/auth/cloudflare-access/*.test.ts`.

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
  without it. cf uploads a new version without the secret, so run the next
  `everyapp gateway` command from a terminal: it asks before replacing a
  version it didn't upload.)

  ```sh
  npx cf@1.0.0-beta.14 workers secrets delete CLOUDFLARE_ACCESS_AUD --worker every-app-gateway
  ```

- **"This gateway signs people in through Cloudflare Access, and this
  request didn't come through it."** The outer ring is configured, but the
  request carried no assertion Access signed for one of your AUD tags:
  Access isn't in front of that hostname, the path is bypassed, or the AUD
  tag is wrong. Fix the Access application or the secrets.
- **"You don't have an account on this gateway yet."** Invite them, or add
  their domain to `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`.
- **Teammates can't log in at Access at all.** The organization allows only
  Cloudflare account members: add the one-time PIN identity provider.
- **The 51st person is blocked by Access.** The Free plan has 50 seats.
- **App sync breaks behind the outer ring (WebSocket 403).** The Access
  application is attached to the Worker; use hostname destinations.
- **Apps keep sending people back to the sign-in page** ("the page you were
  going to sent you back here") behind the outer ring. Their hosts' Access
  application isn't one the gateway knows: put its AUD tag in
  `CLOUDFLARE_ACCESS_APPS_AUD`.
- **MCP clients get an HTML login page.** A bypass path is missing. (Connecting an AI app does show Access's login in the
  browser, at `/oauth/authorize`: that page is for people.)
- **Someone you took out of the Access policy still uses an AI app or a
  script.** Tokens never pass through Access: deactivate them (see "Taking
  someone off").
- **The mobile app can't sign in behind the outer ring.** Expected; use OIDC
  sign-in for teams that use the app.
