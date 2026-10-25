# Sign in with GitHub on the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Puts **Continue with GitHub** on the Gateway's sign-in page, beside the
password. At the end the person has a GitHub OAuth App, its two settings
on the Gateway, and has signed in with GitHub once.
`pnpm everyapp signin show github --json` names this file as `setup`, and
the CLI prints `Guide: .claude/skills/everyapp/setup/signin-github.md`.

Who gets in doesn't change: GitHub only says who someone is, by their
primary address, and only when GitHub marks it verified. A member signs
in; someone with a pending invitation for that exact address joins with
the invited role; everyone else is refused ("You don't have an account on
this gateway.") and nothing is created. An existing password account
connects GitHub once, by signing in with the password when the page asks.
The rules: `docs/runbooks/sign-in-providers.md`, "Who gets in".

An **OAuth App**, not a GitHub App: the two live side by side under
Developer settings, and only an OAuth App fits here.

## Settings

| Name                          | Required | Flag                             | What it holds                                  |
| ----------------------------- | -------- | -------------------------------- | ---------------------------------------------- |
| `GITHUB_SIGNIN_CLIENT_ID`     | required | `--client-id <id>`               | the OAuth App's Client ID; not a secret        |
| `GITHUB_SIGNIN_CLIENT_SECRET` | required | `--client-secret-from-env <VAR>` | a client secret generated on the OAuth App     |

Scopes asked for: `read:user user:email`. The email is the person's
primary address from GitHub's emails API, counted only when verified.

## Costs and plans

Free, on any GitHub account. An OAuth App can belong to the person's own
account or to an organization they administer (up to 100 per owner); an
organization owner keeps it from depending on one person.

## Only a person can

- Sign in to GitHub and register the OAuth App.
- Generate the client secret and copy it off the screen.
- Type the secret at the hidden prompt of `pnpm everyapp signin add github`.
- Sign in with GitHub to check it.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true;
   `data.gatewayUrl` gives `<gateway host>`. Not installed or no owner:
   [gateway.md](gateway.md) first. `data.access.on` true: see Verify 4.
2. `pnpm everyapp signin show github --json` (changes nothing; `Unknown
   command signin`: `git pull` in the `every-app` folder). `data.status`
   `off`: this file applies; `needs setup`: `data.missing` says what is
   left (step 4); `on`: ask before replacing. `data.callbackUrl` is
   `https://<gateway host>/api/auth/callback/github`.
3. Ask whether the app should belong to their own account or to an
   organization they administer.

## Steps

1. **You:** give the person `data.callbackUrl`.
2. **Person:** open https://github.com/settings/developers (for an
   organization: the organization's **Settings** → **Developer settings**
   → **OAuth Apps**) → **New OAuth App** (**Register a new application**
   when there is none yet). Application name (people see it, for example
   `Every App`), Homepage URL `https://<gateway host>`, **Authorization
   callback URL** the exact URL from step 1. Leave **Enable Device Flow**
   off. **Register application**. The app's page shows the **Client ID**.
3. **Person:** on that page, **Generate a new client secret** (GitHub may
   ask for their password or 2FA again). The secret is shown once; keep
   the page open for step 4.
4. **Person:** in a second terminal in the `every-app` folder:
   ```sh
   pnpm everyapp signin add github
   ```
   It asks for the Client ID (shown as typed) and the client secret
   (hidden: pasting works, nothing is echoed), and writes both in one new
   Gateway Worker version, live on the next request. They tell you when
   it's done.
   Another way: in that terminal, the hidden read (bash or zsh:
   `read -rs GITHUB_SIGNIN_CLIENT_SECRET && export GITHUB_SIGNIN_CLIENT_SECRET`;
   fish: `read -s -x GITHUB_SIGNIN_CLIENT_SECRET`), paste, Enter, then
   `pnpm everyapp signin add github --client-id <Client ID> --client-secret-from-env GITHUB_SIGNIN_CLIENT_SECRET --json`
   and `unset GITHUB_SIGNIN_CLIENT_SECRET` (fish: `set -e GITHUB_SIGNIN_CLIENT_SECRET`).

## Verify

1. `pnpm everyapp signin list --json`: the `github` entry has `status:
   "on"` and `missing` empty.
2. The person's GitHub primary address (https://github.com/settings/emails,
   marked Primary, not Unverified) must be a member's or have a pending
   invitation: `pnpm everyapp workspace invite <email>` for someone new.
3. **Person:** private window, `https://<gateway host>/sign-in` →
   **Continue with GitHub** → **Authorize** on GitHub's page → the
   Gateway, signed in.
4. Behind Cloudflare Access: nothing else changes, but the GitHub primary
   address must be the one Access knows the person by.
5. Logs (README's Verify 4): `signin.config_problem` for a malformed or
   missing setting.

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| no **Continue with GitHub** button | a setting missing or malformed, or the version isn't live yet | `pnpm everyapp signin list --json`; logs' `signin.config_problem` |
| `redirect_uri_mismatch`: "The redirect_uri MUST match the registered callback URL for this application." | the Authorization callback URL isn't exactly `data.callbackUrl` | fix it on the OAuth App's page → **Update application** |
| "The sign-in provider hasn't verified this email address." | the primary address is unverified at GitHub | the person verifies it in GitHub's Emails settings, or makes a verified one primary |
| "You don't have an account on this gateway." | the primary address isn't a member's or invited | invite that address (people often sign up to GitHub with a personal one) |
| `incorrect_client_credentials` | the secret doesn't belong to this Client ID | Rotate |
| `SIGNIN_VALUE_REQUIRED` / `SECRET_EMPTY` | unattended, a required setting neither given nor set / the env variable empty in that shell | `data.rerun` with the flag / the hidden read again in the same terminal |
| `SIGNIN_FLAG_NOT_APPLICABLE` | `--tenant`, `--issuer` or `--label` given for GitHub | drop it |

## Rerun, rotate, remove

- Rerun: `pnpm everyapp signin add github` any time; values given replace,
  settings not given are kept (Enter at a prompt keeps it).
- Rotate: **Generate a new client secret** on the OAuth App (an app holds
  several at once), then `pnpm everyapp signin add github` with Enter at
  the Client ID prompt, or the hidden read and
  `pnpm everyapp signin add github --client-secret-from-env GITHUB_SIGNIN_CLIENT_SECRET --json`.
  Then **Delete** the old secret on GitHub.
- Remove, only when asked: `pnpm everyapp signin remove github --json --yes`
  (`--yes` only when they said so). Accounts made with it stay. Then delete
  the OAuth App (its page → **Advanced** → **Delete application**).

## Sources

- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
  (Settings → Developer settings → OAuth apps → New OAuth App; fields;
  organization owners; 100 apps per owner)
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
  (`read:user`, `user:email`)
- https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors
  and https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors
  (redirect URI mismatch, `incorrect_client_credentials`)
- The **Generate a new client secret**, **Advanced** and **Delete
  application** labels are from GitHub's UI as the runbook records them;
  GitHub's docs pages above don't show them (unverified).
- `docs/runbooks/sign-in-providers.md` ("GitHub") and
  `packages/sdk/src/internal/signInProviders.ts`
