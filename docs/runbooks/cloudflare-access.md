# Use Cloudflare Access to sign in

Cloudflare Access is a second wall in front of a self-hosted Gateway and its
apps: everyone signs in to Access first (their own Cloudflare account, "Sign
in with Cloudflare", for the members of your Cloudflare account; a one-time
PIN emailed to everyone else), and Access asks the Gateway whether that
person is a member or invited before it lets them through. Better Auth stays
the system of record for users, sessions, organizations, roles, invitations,
personal access tokens and the OAuth server MCP clients use. An Access
sign-in ends in an ordinary Better Auth session, so everything after it
works as after a password.

```
person ──► Cloudflare Access ──────► gateway: verifies Access's signed token,
           (Cloudflare login or PIN)  applies membership rules, creates a
              │      ▲                Better Auth session
              ▼      │ yes / no
           gateway /access-evaluation (is this email a member or invited?)
```

`everyapp setup` turns it on by default once the owner exists, and
`everyapp access on` turns it on, or puts it back as it should be, in one
fixed recipe. The full reference for agents is
`landing-page/content/agent/access.md` (served at
https://everyapp.com/docs/agent/access); this page is the operator's view.

All settings are Worker secrets. None can be changed from the admin UI, so a
stolen admin session can't add a way in. See also
`docs/runbooks/sign-in-providers.md`: "Continue with Google" and others on
the Gateway's own sign-in page, with or without Access in front.

## What `access on` makes

```sh
pnpm everyapp access on            # asks for a team name when the account has none
pnpm everyapp access on --team acme --json
```

1. The Zero Trust team, when the account has none: `<name>.cloudflareaccess.com`
   is the sign-in page, permanent once used. No dashboard onboarding, plan
   pick or payment details are needed for the API path.
2. Two identity providers: **Sign in with Cloudflare** (restricted to your
   account's members) and the **one-time PIN**, each created when missing.
3. One reusable policy, **Every App gateway members**, with one rule: an
   External Evaluation rule whose evaluate URL is
   `https://<gateway>/access-evaluation/evaluate` and keys URL
   `https://<gateway>/access-evaluation/keys`. Access asks the Gateway after
   every Access sign-in; the Gateway answers yes for an account that belongs
   to an organization and isn't deactivated, or for a pending invitation.
4. Two hostname-based applications, both with that policy, a `720h` session,
   the HttpOnly and binding cookies, and the two providers: **Every App
   gateway** on the Gateway's host (its AUD tag signs people in) and **Every
   App apps** on `*.<app base domain>` (its AUD tag only vouches for a
   session on an app host). Machine endpoints and each served app's public
   routes are bypassed (below).
5. The Gateway's settings `CLOUDFLARE_ACCESS_TEAM_DOMAIN`,
   `CLOUDFLARE_ACCESS_AUD` and `CLOUDFLARE_ACCESS_APPS_AUD`, in one new
   Worker version, every run.

Run it again any time: it changes only what differs, keeps destinations,
policies and identity providers it didn't make, and rewrites the three
settings (how an application recreated by hand, with a new AUD tag, is
picked up). `pnpm everyapp access show` reports what is there;
`pnpm everyapp access off` removes the settings, then the applications.

### When to run it again

- After deploying an app whose public routes changed: `deploy` says so
  (`ACCESS_RERUN_NEEDED`). A deploy never touches Access.
- After a Gateway release whose notes say the Gateway's bypass list changed.
- After changing Access by hand in the dashboard.

Never for an invitation: invite people in the Gateway and they can sign in
through Access at once, because Access asks the Gateway.

## Who gets in

Three checks, one list (the Gateway's members and invitations):

1. Access's sign-in, then its policy: the Gateway's yes or no.
2. The Gateway's own membership check on every sign-in: members who aren't
   deactivated, and invitees (their invitation is accepted then, with the
   invited role and the organization's default apps). Everyone else is
   refused (`ACCESS_NOT_INVITED`), and nothing is created for them.
3. On every app-host request, a Gateway session counts only alongside
   Access's signed header for the same person on that request.

External Evaluation is checked at Access sign-in, not on every request, and
an Access session lasts `720h`. Take someone off by **deactivating** them in
the Gateway (**Manage workspace → Users → ⋯ → Deactivate**): their sessions,
personal tokens and AI connections end at once, the Gateway refuses them on
every request, and Access refuses them at their next Access sign-in. Revoke
their Access session in **Zero Trust → My Team → Users** to end that sooner.

An existing account is linked to its Access identity on the person's first
Access sign-in, by email. That is safe behind the outer ring: no session
there counts without Access's word for that same email on the request.
Invite people with the address Access will see.

Enable only identity providers that verify email addresses. `access on`
allows the one-time PIN and Sign in with Cloudflare restricted to your
account's members; a provider you add in the dashboard (Okta, Google
Workspace) is kept on the applications. `CLOUDFLARE_ACCESS_IDP_IDS` pins the
Gateway to listed provider ids.

## Bypassed paths

| Path                                                     | Where                                                   | Why                                                       |
| -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `/mcp`, `/mcp/*`                                         | Gateway host only (an app host serves no MCP)           | MCP clients bring an OAuth or personal token              |
| `/oauth/token`, `/oauth/register`, `/.well-known/*`      | Gateway host                                            | The OAuth server's machine endpoints and discovery        |
| `/linked-dev/*`                                          | Gateway host                                            | `everyapp dev --gateway`, bearer only                     |
| `/health`                                                | Gateway host                                            | Uptime monitors                                           |
| `/api/auth/callback/apple`                               | Gateway host                                            | Apple's cross-site POST, which only redirects to a GET    |
| `/access-evaluation/*`                                   | Gateway host                                            | Access's own call asking who is a member, and its key     |
| each app's `public` routes                               | that app's host                                         | Webhooks, tracking scripts, share pages                   |
| bearer routes (`bearer: true`), `/.well-known/oauth-protected-resource` | that app's host                          | Native apps' calls with a Gateway token; no cookie taken  |

Everything else stays behind Access, `/oauth/authorize` and the consent page
included. The Gateway still enforces every route itself.

## OIDC sign-in

Instead of, or beside, the outer ring: a "Continue with Company SSO" button
backed by an Access for SaaS application. `access on` doesn't make it.

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
everyapp secret set CLOUDFLARE_ACCESS_OIDC_ISSUER        # https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>
everyapp secret set CLOUDFLARE_ACCESS_OIDC_CLIENT_ID
everyapp secret set CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET
everyapp secret set CLOUDFLARE_ACCESS_OIDC_LABEL         # optional: Company SSO
```

The issuer must be on your team domain and end in the client id; anything
else turns OIDC sign-in off and logs `access.config_problem`. An existing
account connects through Better Auth's rules: only when its email is
verified, else after one password sign-in.

## Turning passwords off

```sh
everyapp secret set EMAIL_PASSWORD_SIGN_IN
# false
```

It takes effect only once an owner can sign in another way (an Access
identity, linked on their first Access sign-in, or a sign-in provider), so
it can't lock the owner out. `true` turns passwords back on.

## Costs and limits

The Zero Trust Free plan covers 50 users; the 51st is blocked. Every person
who signs in through Access uses a seat; bypassed paths and service tokens
use none. External Evaluation is on every plan. A destination takes at most
25 path overrides.

## Test locally

`apps/every-app-gateway/scripts/access-local.mjs` is a mock Access: an OIDC
application, and with `--proxy-port` an outer ring in front of a `vite dev`
gateway (with `--apps-aud`, a separate application on app hosts), each
bypassing the paths above and setting a `CF_Authorization` cookie as Access
does. It doesn't ask the Gateway who is a member (the Gateway's own check
on sign-in still refuses strangers).

```sh
cd apps/every-app-gateway
node scripts/access-local.mjs --port 19410 --proxy-port 19301 --gateway http://localhost:19300 --apps-aud local-apps-aud
pnpm db:migrate:local
pnpm exec vite dev --port 19300 --strictPort
GATEWAY_URL=http://localhost:19301 pnpm setup-link
```

Copy the printed lines into `.dev.vars` (loopback URLs are accepted only in
`vite dev` builds) and browse `http://localhost:19301`. The automated tests
cover the same ground: `src/auth/cloudflare-access/*.test.ts` and
`src/server/access-evaluation.sqlite.test.ts`.

## Troubleshooting

- **Nobody gets past Access** ("That account does not have access"). The
  policy asks the Gateway, so the Gateway must answer: check `/health`, that
  the person is a member or invited, and the Worker's logs for
  `access.evaluated` (`member: false`) or `access.evaluation_refused`.
  `access show` says whether the policy still asks the Gateway
  (`asksGateway`); `access on` puts it back. To get in at once,
  `pnpm everyapp access off`.
- **Locked out behind the outer ring** (a wrong AUD tag, Access
  misconfigured). `pnpm everyapp secret unset CLOUDFLARE_ACCESS_AUD` turns
  the outer ring off at once (Access still guards the hostnames). Without a
  checkout: `npx cf@1.0.0-beta.14 workers secrets delete CLOUDFLARE_ACCESS_AUD --worker every-app-gateway`.
- **"This gateway signs people in through Cloudflare Access, and this
  request didn't come through it."** Access isn't in front of that hostname,
  the path is bypassed, or the AUD tag is wrong (an application recreated
  in the dashboard has a new one): `pnpm everyapp access on`.
- **Access says you're someone else** ("You're signed in to Cloudflare Access
  as X, but this account is Y"). Use **Not you? Sign out of Access** (or
  `/cdn-cgi/access/logout`) and sign in as Y; if the person is X, invite X.
- **An app's webhook or public page gets Access's login.** Its public routes
  changed since the last `access on`: run it again.
- **Apps keep sending people back to the sign-in page.** Their hosts'
  application isn't one the Gateway knows: `pnpm everyapp access on` writes
  its AUD to `CLOUDFLARE_ACCESS_APPS_AUD`.
- **MCP clients get an HTML login page.** A bypass path is missing:
  `pnpm everyapp access on`. (Connecting an AI app does show Access's login
  in the browser, at `/oauth/authorize`: that page is for people.)
- **No "Continue with" button / "Signing in with … didn't finish."**
  `access.config_problem` names the OIDC setting; the redirect URL must be
  exactly `https://<gateway>/api/auth/callback/cloudflare-access`, with PKCE.
- **The 51st person is blocked by Access.** The Free plan has 50 seats.
- **App sync breaks behind the outer ring (WebSocket 403).** The application
  is attached to the Worker; use hostname destinations.
