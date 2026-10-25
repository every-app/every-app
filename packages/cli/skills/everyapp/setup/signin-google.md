# Sign in with Google on the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Puts **Continue with Google** on the Gateway's sign-in page, beside the
password. At the end the person has an OAuth client in a Google Cloud
project, its two settings on the Gateway, and has signed in with Google
once. `pnpm everyapp signin show google --json` names this file as
`setup`, and the CLI prints `Guide: .claude/skills/everyapp/setup/signin-google.md`.

Who gets in doesn't change: Google only says who someone is (an email it
verified). A member signs in; someone with a pending invitation for that
exact address joins with the invited role, no link or password needed;
everyone else is refused ("You don't have an account on this gateway.")
and nothing is created. An existing password account connects Google once:
the first "Continue with Google" says an account exists, the person signs
in with the password and the page connects Google (or **Connect Google** in
the account menu). The full rules: `docs/runbooks/sign-in-providers.md`,
"Who gets in".

This is not the Google client apps use for Gmail and Calendar
(`GOOGLE_WORKSPACE_*`, [google.md](google.md)). Make a separate client
here. When that other client's project is *External* and still in Testing
(its Gmail scope waits on Google's verification), make this one in a
separate project too: publishing is per project, and this one must be
published (step 2).

## Settings

| Name                          | Required | Flag                             | What it holds                                                   |
| ----------------------------- | -------- | -------------------------------- | --------------------------------------------------------------- |
| `GOOGLE_SIGNIN_CLIENT_ID`     | required | `--client-id <id>`               | the client's Client ID, ending in `.apps.googleusercontent.com`; not a secret |
| `GOOGLE_SIGNIN_CLIENT_SECRET` | required | `--client-secret-from-env <VAR>` | the client's Client secret, shown once at creation              |

Scopes asked for: `openid email profile`, identity only. The email is the
ID token's `email`, and only when `email_verified` is true (every Google
account's own address is).

## Costs and plans

Free: a Google Cloud project and an OAuth client for sign-in need no
billing account. The identity scopes are not sensitive, so the consent
screen can be published without Google's sensitive-scope verification
(whether Google still asks for brand verification before showing the
app's name and logo: unverified).

## Only a person can

- Sign in to Google Cloud, create the project and the consent screen.
- Create the OAuth client and copy its secret off the screen.
- Publish the consent screen (In production).
- Type the secret at the hidden prompt of `pnpm everyapp signin add google`.
- Sign in with Google to check it.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true;
   `data.gatewayUrl` gives `<gateway host>`. Not installed, or no owner:
   [gateway.md](gateway.md) first (nobody signs in with a provider before
   the Gateway is claimed). `data.access.on` true: see Verify 4.
2. `pnpm everyapp signin show google --json` (changes nothing). `Unknown
   command signin` (exit 251): the checkout predates sign-in providers;
   `git pull` in the `every-app` folder, then again. Read `data.status`:
   `off`, this file applies; `needs setup`, `data.missing` names what is
   left (go to step 3); `on`, it works already: ask before replacing (a new
   secret for the same client is harmless, see Rotate). `data.callbackUrl`
   is the redirect URL, `https://<gateway host>/api/auth/callback/google`.
3. Ask whether a Google Cloud project for this exists already, and whether
   everyone who will sign in is in one Google Workspace organization
   (then the consent screen can be *Internal*: no publishing needed).

## Steps

1. **You:** give the person `data.callbackUrl` from Before you start 2.
2. **Person:** the consent screen, once per project. Open
   https://console.cloud.google.com/auth/overview (pick or create the
   project in the top bar) → **Get started**: App name (what people see,
   for example `Every App`), User support email → Next; Audience
   *Internal* (one Workspace organization) or *External* → Next; Contact
   Information → Next; agree to the User Data Policy → **Create**.
   *External* only: https://console.cloud.google.com/auth/audience →
   **Publish app** → Confirm. While it says Testing, only the test users
   listed there can sign in. Done when the Audience page says "In
   production" (or the app is *Internal*).
3. **Person:** the client. https://console.cloud.google.com/auth/clients →
   **Create client** → Application type **Web application** → Name (for
   example `Every App sign-in`) → **Authorized redirect URIs** → **Add
   URI** → the exact URL from step 1 → **Create**. No JavaScript origins.
   A dialog shows the Client ID and the Client secret; keep it open (the
   secret is shown only now; afterwards only its last four characters).
   Redirect URI changes can take 5 minutes to a few hours to apply.
4. **Person:** set both on the Gateway, in a second terminal in the
   `every-app` folder:
   ```sh
   pnpm everyapp signin add google
   ```
   It prints where the client is made and the redirect URL, then asks for
   the Client ID (shown as typed) and the Client secret (hidden: pasting
   works, nothing is echoed). It ends with Google on and the sign-in URL.
   They tell you when it's done. Both go on in one new version of the
   Gateway Worker, live on the next request.
   Another way, when they'd rather not use the prompts: in that terminal
   they read the secret in hidden (bash or zsh:
   `read -rs GOOGLE_SIGNIN_CLIENT_SECRET && export GOOGLE_SIGNIN_CLIENT_SECRET`;
   fish: `read -s -x GOOGLE_SIGNIN_CLIENT_SECRET`), paste, press Enter, then
   run `pnpm everyapp signin add google --client-id <Client ID> --client-secret-from-env GOOGLE_SIGNIN_CLIENT_SECRET --json`
   and `unset GOOGLE_SIGNIN_CLIENT_SECRET` (fish: `set -e GOOGLE_SIGNIN_CLIENT_SECRET`).
   The Client ID isn't a secret, so it may sit on the command line.
5. **Person:** close the client dialog (Google keeps no copy of the secret
   to show again; a lost one is replaced in Rotate).

## Verify

1. `pnpm everyapp signin list --json`: the `google` entry has `status:
   "on"` and `missing` empty.
2. The person's address must be a member's or have a pending invitation.
   For someone new: `pnpm everyapp workspace invite <email>` (it prints an
   invitation link; for Google sign-in they don't need it, the pending
   invitation for that exact address is enough).
3. **Person:** in a private window open `https://<gateway host>/sign-in`:
   **Continue with Google** is there. Select it, choose the Google account,
   and they land on the Gateway signed in. An existing password account
   first sees "An account with this email already exists": sign in with
   the password once, and the page connects Google.
4. Behind Cloudflare Access (`data.access.on`): nothing else changes, but
   the Google account's address must be the one Access knows the person
   by; otherwise the page says Access knows them by another email.
5. Logs (README's Verify 4): `signin.config_problem` names a malformed or
   missing setting, the reason the button stays off.

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| no **Continue with Google** button | the provider isn't on: a setting missing or malformed, or the new version isn't live yet | `pnpm everyapp signin list --json` (`missing`); the logs' `signin.config_problem`; `signin add google` again |
| Google's "Error 400: redirect_uri_mismatch" | the client's redirect URI isn't exactly `data.callbackUrl` | fix it under Authorized redirect URIs (no trailing slash; `https`); wait a few minutes |
| Google refuses someone before the Gateway sees them (its wording for people not on Test users: unverified) | the consent screen is *External* and still in Testing: only test users get in, and their grants expire after seven days | **Publish app** (step 2) |
| Google's `org_internal` error | the consent screen is *Internal* and the person's Google account is outside that organization | they use their Workspace account, or the audience becomes *External* and published |
| "You don't have an account on this gateway." | the address Google returned isn't a member's and has no pending invitation | `pnpm everyapp workspace invite <email>` with the Google address, exactly as Google spells it |
| "The sign-in provider hasn't verified this email address." | Google reports the address unverified (a secondary, unverified address on a non-Gmail account) | the person verifies it at Google, or uses another account |
| "An account with this email already exists." | a password account has that address and isn't verified yet | sign in with the password once; the page connects Google |
| `SIGNIN_VALUE_REQUIRED` | unattended, and a required setting has no flag and isn't set yet | `data.missing` names it; rerun `data.rerun` with the flag |
| `SECRET_EMPTY` | the `--client-secret-from-env` variable is empty or unset in that shell | the hidden read again, in the same terminal |
| `SIGNIN_FLAG_NOT_APPLICABLE` | a flag Google doesn't take (`--tenant`, `--issuer`, `--label`) | drop it |
| Google's "invalid_client" | the secret doesn't belong to this Client ID (a typo, or another client's) | Rotate |

## Rerun, rotate, remove

- Rerun: `pnpm everyapp signin add google` any time. A value given
  replaces; a setting not given and already set is kept (at the prompt,
  Enter keeps it). The done event's `data.set` and `data.kept` say which.
- Rotate: on the client's page (https://console.cloud.google.com/auth/clients
  → the client) add a new secret, then the person runs
  `pnpm everyapp signin add google` and presses Enter at the Client ID
  prompt, pasting only the new secret; or the hidden read and
  `pnpm everyapp signin add google --client-secret-from-env GOOGLE_SIGNIN_CLIENT_SECRET --json`
  (the Client ID is kept). Then disable and delete the old secret there.
- Remove, only when the person asks:
  `pnpm everyapp signin remove google --json --yes` (`--yes` only when they
  said so; at a terminal it asks). Every `GOOGLE_SIGNIN_*` setting goes in
  one version; people who signed in with Google keep their accounts and
  use another way in. Then delete the client in the console.

## Sources

- https://support.google.com/cloud/answer/15549257 (Clients page, Create
  client, Web application, Authorized redirect URIs, the secret shown once,
  5 minutes to a few hours)
- https://developers.google.com/identity/openid-connect/openid-connect
  (`openid email profile`, `email_verified`)
- https://support.google.com/cloud/answer/13464321 (which scopes need
  verification; the identity scopes are not sensitive)
- https://support.google.com/cloud/answer/15549945 (Manage App Audience:
  Internal, External, Testing and test users, seven-day grants, Publish
  app, `org_internal`)
- `docs/runbooks/sign-in-providers.md` ("Who gets in", "Existing accounts",
  "Google", "Troubleshooting") and the catalog,
  `packages/sdk/src/internal/signInProviders.ts`
