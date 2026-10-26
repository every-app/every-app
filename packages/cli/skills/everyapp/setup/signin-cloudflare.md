# Sign in with Cloudflare on the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Puts **Continue with Cloudflare** on the Gateway's sign-in page, beside
the password, for the members of the person's Cloudflare account. At the
end the person has a private OAuth client in that account, its two
settings on the Gateway, and has signed in with Cloudflare once.
`pnpm everyapp signin show cloudflare --json` names this file as `setup`,
and the CLI prints `Guide: .claude/skills/everyapp/setup/signin-cloudflare.md`.

Who gets in doesn't change: Cloudflare only says who someone is. A member
of the Gateway signs in; someone with a pending invitation for that exact
address joins with the invited role; everyone else is refused ("You don't
have an account on this gateway.") and nothing is created. An existing
password account connects Cloudflare once, by signing in with the password
when the page asks. The rules: `docs/runbooks/sign-in-providers.md`.

**Keep the client private** (the default). Cloudflare's `/user` answer has
no "verified" flag; the address is trusted only because a private client
can be authorized by nobody but the Cloudflare account's members, who got
in by accepting an invitation sent to that address. Making a client public
is permanent and would let any Cloudflare user present an address nobody
checked. Everyone outside the Cloudflare account uses another provider, a
password, or Access's one-time PIN.

Not the same as Access's "Sign in with Cloudflare" ([access.md](access.md)):
that one is a login *in front of* the Gateway, at Cloudflare's edge, for
every page and app. This one is a button *on* the Gateway's sign-in page,
like Google's. Both can be on; with Access on, this button is rarely needed.

## Settings

| Name                              | Required | Flag                             | What it holds                                    |
| --------------------------------- | -------- | -------------------------------- | ------------------------------------------------ |
| `CLOUDFLARE_SIGNIN_CLIENT_ID`     | required | `--client-id <id>`               | the OAuth client's Client ID; not a secret       |
| `CLOUDFLARE_SIGNIN_CLIENT_SECRET` | required | `--client-secret-from-env <VAR>` | the OAuth client's Client Secret, shown once     |

Scope asked for: `user-details.read` (User Details Read), nothing an app
could act with. The email is the Cloudflare API's `/user` `email`.

## Costs and plans

No price on Cloudflare's OAuth client page, and no plan named (free as far
as checked; unverified). Creating a client needs the Super Administrator,
Administrator or OAuth Client Write role on the account.

## Only a person can

- Sign in to the Cloudflare dashboard and create the OAuth client.
- Copy the Client Secret off the screen (shown once).
- Type it at the hidden prompt of `pnpm everyapp signin add cloudflare`.
- Sign in with Cloudflare to check it; decide never to make the client
  public.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true;
   `data.gatewayUrl` gives `<gateway host>`. Not installed or no owner:
   [gateway.md](gateway.md) first. `data.access.on` true: see Verify 4.
2. `pnpm everyapp signin show cloudflare --json` (changes nothing;
   `Unknown command signin`: `git pull` in the `every-app` folder).
   `data.status` `off`: this file applies; `needs setup`: `data.missing`
   says what is left (step 3); `on`: ask before replacing.
   `data.callbackUrl` is `https://<gateway host>/api/auth/callback/cloudflare`.
3. Ask who should use it: only people who are members of their Cloudflare
   account can. For anyone else, suggest Google, Microsoft or the password.

## Steps

1. **You:** give the person `data.callbackUrl`.
2. **Person:** in the Cloudflare dashboard, the account the Gateway runs
   in: https://dash.cloudflare.com/?to=/:account/oauth-clients (or
   **Manage Account** → **OAuth clients**) → **Create client**. Client name
   (`EveryApp`); response type code, grant type **Authorization Code**;
   token authentication method `client_secret_basic`; redirect URL the
   exact URL from step 1 → **Continue** → scopes: **User Details Read**,
   left **Required** (an optional one can be declined, and then sign-in
   can't finish) → **Create client**. The page shows the **Client ID** and
   the **Client Secret**, the secret only now. Leave its visibility
   private: never **Change Visibility**.
3. **Person:** in a second terminal in the `every-app` folder:
   ```sh
   pnpm everyapp signin add cloudflare
   ```
   It asks for the Client ID (shown as typed) and the Client Secret
   (hidden: pasting works, nothing is echoed), and writes both in one new
   Gateway Worker version, live on the next request. They tell you when
   it's done.
   Another way: in that terminal, the hidden read (bash or zsh:
   `read -rs CLOUDFLARE_SIGNIN_CLIENT_SECRET && export CLOUDFLARE_SIGNIN_CLIENT_SECRET`;
   fish: `read -s -x CLOUDFLARE_SIGNIN_CLIENT_SECRET`), paste, Enter, then
   `pnpm everyapp signin add cloudflare --client-id <Client ID> --client-secret-from-env CLOUDFLARE_SIGNIN_CLIENT_SECRET --json`
   and `unset CLOUDFLARE_SIGNIN_CLIENT_SECRET` (fish: `set -e CLOUDFLARE_SIGNIN_CLIENT_SECRET`).

## Verify

1. `pnpm everyapp signin list --json`: the `cloudflare` entry has `status:
   "on"` and `missing` empty.
2. The person's Cloudflare login address must be a Gateway member's or
   have a pending invitation: `pnpm everyapp workspace invite <email>` for
   someone new (who must also be a member of the Cloudflare account).
3. **Person:** private window, `https://<gateway host>/sign-in` →
   **Continue with Cloudflare** → Cloudflare's login → the consent screen
   → allow → the Gateway, signed in.
4. Behind Cloudflare Access: nothing else changes, but the Cloudflare
   address must be the one Access knows the person by.
5. Logs (README's Verify 4): `signin.config_problem` for a malformed or
   missing setting.

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| no **Continue with Cloudflare** button | a setting missing or malformed, or the version isn't live yet | `pnpm everyapp signin list --json`; logs' `signin.config_problem` |
| Cloudflare refuses the redirect (wording unverified) | the client's redirect URL isn't exactly `data.callbackUrl` | fix it on the client |
| Cloudflare refuses someone at its consent screen | they aren't a member of the Cloudflare account (a private client) | invite them to the Cloudflare account, or they use another way in |
| the Gateway refuses after consent, or the profile can't be read | **User Details Read** missing or made optional and declined | edit the client: the scope, **Required** |
| "You don't have an account on this gateway." | their Cloudflare address isn't a member's or invited | `pnpm everyapp workspace invite <email>` with the Cloudflare address |
| `SIGNIN_VALUE_REQUIRED` / `SECRET_EMPTY` | unattended, a required setting neither given nor set / the env variable empty in that shell | `data.rerun` with the flag / the hidden read again in the same terminal |
| Create client is missing or refused | the person's role on the account lacks OAuth Client Write | an Administrator creates it, or grants the role |

## Rerun, rotate, remove

- Rerun: `pnpm everyapp signin add cloudflare` any time; values given
  replace, settings not given are kept (Enter at a prompt keeps it).
- Rotate: rotate the secret on the client's page in the dashboard (a lost
  secret can only be rotated), then `pnpm everyapp signin add cloudflare`
  with Enter at the Client ID prompt, or the hidden read and
  `pnpm everyapp signin add cloudflare --client-secret-from-env CLOUDFLARE_SIGNIN_CLIENT_SECRET --json`.
- Remove, only when asked: `pnpm everyapp signin remove cloudflare --json --yes`
  (`--yes` only when they said so). Accounts made with it stay. Then
  delete the client in **Manage Account** → **OAuth clients**.

## Sources

- https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
  (Manage Account → OAuth clients → Create client; the three roles;
  Authorization Code only; `client_secret_basic`; Required scopes; secret
  shown once; private by default, public permanent, Change Visibility; no
  price on the page)
- https://developers.cloudflare.com/api/resources/user/methods/get/
  (`GET /user`, User Details Read)
- https://better-auth.com/docs/authentication/cloudflare (`/user` for the
  email; keep `user-details.read` required)
- `docs/runbooks/sign-in-providers.md` ("Cloudflare", "Sign in with
  Cloudflare: Access's identity provider versus this") and
  `packages/sdk/src/internal/signInProviders.ts`
