# Sign in with Microsoft on the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Puts **Continue with Microsoft** on the Gateway's sign-in page, beside the
password: work or school accounts from the person's Microsoft Entra
directory (Microsoft 365), or any Microsoft account. At the end the person
has an app registration in Entra, its settings on the Gateway, and has
signed in with Microsoft once. `pnpm everyapp signin show microsoft --json`
names this file as `setup`, and the CLI prints
`Guide: .claude/skills/everyapp/setup/signin-microsoft.md`.

Who gets in doesn't change: Microsoft only says who someone is. A member
signs in; someone with a pending invitation for that exact address joins
with the invited role; everyone else is refused ("You don't have an
account on this gateway.") and nothing is created. An existing password
account connects Microsoft once, by signing in with the password when the
page asks. The rules: `docs/runbooks/sign-in-providers.md`, "Who gets in".

Not the Outlook mail and calendar client apps use (`MICROSOFT_365_*`,
[microsoft-365.md](microsoft-365.md)): make a separate registration here.

**Which tenant decides which addresses count as verified.** Recommended:
the registration is single tenant and `MICROSOFT_SIGNIN_TENANT` is the
Directory (tenant) ID, so only the person's own directory signs in, and
its addresses are trusted. Otherwise (unset, `common`, `organizations`,
`consumers`) any tenant's admin can put any address on their users
(Microsoft calls the attack "nOAuth"), so the Gateway trusts an address
only with the token's own word for it: the optional claims `email` and
`xms_edov` (step 4). Without them every sign-in is refused as unverified.

## Settings

| Name                             | Required | Flag                             | What it holds                                                    |
| -------------------------------- | -------- | -------------------------------- | ---------------------------------------------------------------- |
| `MICROSOFT_SIGNIN_CLIENT_ID`     | required | `--client-id <id>`               | the registration's Application (client) ID; not a secret        |
| `MICROSOFT_SIGNIN_CLIENT_SECRET` | required | `--client-secret-from-env <VAR>` | a client secret's **Value** (it expires; 24 months at most)      |
| `MICROSOFT_SIGNIN_TENANT`        | optional | `--tenant <GUID\|common\|organizations\|consumers>` | the Directory (tenant) ID; unset means any Microsoft account (`common`) |

Scopes asked for: `openid profile email`; no Graph scope, no refresh token
kept. The email is the ID token's `email`, verified when the tenant is
pinned, or the token carries `xms_edov: true`, `email_verified: true`, a
matching `verified_primary_email`, or comes from a personal account.

## Costs and plans

No charge for an app registration: any Microsoft Entra tenant has them,
Entra ID Free included (a Microsoft 365 business subscription comes with a
tenant). Microsoft's quickstart lists an Azure account as a prerequisite;
whether a tenant with no Azure subscription can register apps: unverified.
The client secret expires (24 months at most; Microsoft recommends under
12), so a reminder is part of the setup.

## Only a person can

- Sign in to the Microsoft Entra admin center (at least the Application
  Developer role to register; adding optional claims is documented for
  Cloud Application Administrator, or the app's owner).
- Create the registration and the client secret, and copy its Value.
- Type the secret at the hidden prompt of `pnpm everyapp signin add microsoft`.
- Choose single tenant or any account; sign in with Microsoft to check.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true;
   `data.gatewayUrl` gives `<gateway host>`. Not installed or no owner:
   [gateway.md](gateway.md) first. `data.access.on` true: see Verify 4.
2. `pnpm everyapp signin show microsoft --json` (changes nothing; `Unknown
   command signin`: `git pull` in the `every-app` folder). `data.status`
   `off`: this file applies; `needs setup`: `data.missing` names what is
   left (step 5); `on`: ask before replacing. `data.callbackUrl` is the
   redirect URL, `https://<gateway host>/api/auth/callback/microsoft`;
   `data.set` says whether `MICROSOFT_SIGNIN_TENANT` is set.
3. Ask: only people in your own Microsoft 365 directory (recommended:
   single tenant), or any Microsoft account (guests from other companies,
   outlook.com addresses)? It decides steps 2 and 4.

## Steps

1. **You:** give the person `data.callbackUrl`.
2. **Person:** https://entra.microsoft.com → **Entra ID** → **App
   registrations** → **New registration**. Name (what people see, for
   example `Every App`). **Supported account types**:
   **Single tenant only - <your tenant>** (recommended), or **Any Entra ID
   Tenant + Personal Microsoft accounts** for anyone. **Register**. The **Overview** page
   shows **Application (client) ID** and **Directory (tenant) ID**: both
   are plain ids, not secrets.
3. **Person:** the redirect URL. Under **Manage** → **Authentication** →
   **Redirect URI configuration** → **Add Redirect URI** → **Web** → the
   exact URL from step 1 → **Configure**.
4. **Person,** only when not single tenant: **Token configuration** → **Add
   optional claim** → token type **ID** → tick `email` and `xms_edov` →
   **Add** (accept the prompt to turn on the Microsoft Graph email
   permission if it appears). If `xms_edov` isn't in the list (reported
   for some apps while the claim was in preview; unverified today):
   **Manifest** → under `optionalClaims` → `idToken` add
   `{ "name": "xms_edov", "essential": false }` beside `email` → **Save**.
5. **Person:** the secret. **Certificates & secrets** → **Client secrets**
   → **New client secret** → a description, an expiry (the longest is 24
   months) → **Add**. Copy the **Value** column now (not the Secret ID): it
   is never shown again after leaving the page. Set a calendar reminder
   for a week before it expires.
6. **Person:** in a second terminal in the `every-app` folder:
   ```sh
   pnpm everyapp signin add microsoft
   ```
   It asks for the Application (client) ID (shown as typed), the client
   secret Value (hidden: pasting works, nothing is echoed) and the tenant
   (shown as typed: the Directory (tenant) ID for single tenant; Enter
   leaves it unset). One new Gateway Worker version, live on the next
   request. They tell you when it's done.
   Another way: in that terminal, the hidden read (bash or zsh:
   `read -rs MICROSOFT_SIGNIN_CLIENT_SECRET && export MICROSOFT_SIGNIN_CLIENT_SECRET`;
   fish: `read -s -x MICROSOFT_SIGNIN_CLIENT_SECRET`), paste, Enter, then
   `pnpm everyapp signin add microsoft --client-id <Application (client) ID> --tenant <Directory (tenant) ID> --client-secret-from-env MICROSOFT_SIGNIN_CLIENT_SECRET --json`
   (leave `--tenant` off for any account), then `unset MICROSOFT_SIGNIN_CLIENT_SECRET`
   (fish: `set -e MICROSOFT_SIGNIN_CLIENT_SECRET`).

## Verify

1. `pnpm everyapp signin list --json`: the `microsoft` entry has `status:
   "on"` and `missing` empty; for single tenant, `pnpm everyapp signin show microsoft --json`
   lists `MICROSOFT_SIGNIN_TENANT` in `data.set`.
2. The person's address must be a member's or have a pending invitation:
   `pnpm everyapp workspace invite <email>` for someone new (the pending
   invitation for that exact address is enough; the printed link isn't
   needed for this).
3. **Person:** private window, `https://<gateway host>/sign-in` →
   **Continue with Microsoft** → their work account → (first time) the
   consent screen → **Accept** → the Gateway, signed in.
4. Behind Cloudflare Access: nothing else changes, but the Microsoft
   address must be the one Access knows the person by.
5. Logs (README's Verify 4): `signin.config_problem` names a malformed
   setting (a tenant that isn't a GUID or one of the three words).

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| no **Continue with Microsoft** button | a setting missing or malformed, or the version isn't live yet | `pnpm everyapp signin list --json`; logs' `signin.config_problem` |
| `AADSTS50011` (redirect URI mismatch) | the Web redirect URI isn't exactly `data.callbackUrl` | fix it under Authentication (Web, not Single-page application) |
| "The sign-in provider hasn't verified this email address." | not single tenant, and the token lacks `xms_edov`/`email` | step 4, or pin the tenant (single-tenant registration plus `--tenant`) |
| `AADSTS50020` or "user account … does not exist in tenant" | single tenant, and the person's account is from another directory | invite them as a guest in Entra, or use any-account mode with step 4 |
| `AADSTS7000215` (invalid client secret) | the Secret ID was copied instead of the Value, or the secret expired | Rotate |
| "You don't have an account on this gateway." | no member or invitation for that address | `pnpm everyapp workspace invite <email>` with the address Microsoft returns |
| `SIGNIN_TENANT_INVALID` | `--tenant` isn't a GUID, `common`, `organizations` or `consumers` | the Directory (tenant) ID from Overview |
| `SIGNIN_VALUE_REQUIRED` / `SECRET_EMPTY` | unattended with a required setting neither given nor set / the env variable empty in that shell | `data.rerun` with the flag / the hidden read again in the same terminal |
| sign-in stops after months | the client secret expired | Rotate |

## Rerun, rotate, remove

- Rerun: `pnpm everyapp signin add microsoft` any time; values given
  replace, settings not given are kept (Enter at a prompt keeps it).
- Rotate, before the expiry: **Certificates & secrets** → **New client
  secret**, then `pnpm everyapp signin add microsoft` (Enter at the client
  id and tenant prompts, paste the new Value), or the hidden read and
  `pnpm everyapp signin add microsoft --client-secret-from-env MICROSOFT_SIGNIN_CLIENT_SECRET --json`.
  Then delete the old secret in Entra.
- Drop the tenant pin (any account, after step 4):
  `pnpm everyapp secret unset MICROSOFT_SIGNIN_TENANT --json` (asks at a
  terminal; with `--json`, `--yes` only when the person said so).
- Remove, only when asked: `pnpm everyapp signin remove microsoft --json --yes`
  (`--yes` only when they said so). Accounts made with it stay. Then delete
  the registration in Entra.

## Sources

- https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
  (Entra ID → App registrations → New registration; Supported account
  types; Application (client) ID; Application Developer role)
- https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri
  (Authentication → Redirect URI configuration → Add Redirect URI → Web)
- https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials
  (New client secret; 24 months at most, under 12 recommended; the Value
  is never shown again)
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims
  (Token configuration → Add optional claim; the manifest's `optionalClaims`)
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
  (`xms_edov`: needs the `email` claim; `verified_primary_email`)
- https://learn.microsoft.com/en-us/entra/identity-platform/migrate-off-email-claim-authorization
  (nOAuth: never trust `email` alone)
- `docs/runbooks/sign-in-providers.md` ("Microsoft", "Troubleshooting") and
  `packages/sdk/src/internal/signInProviders.ts`
