# Sign in with Apple on the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Puts **Continue with Apple** on the Gateway's sign-in page, beside the
password. At the end the person has an App ID, a Services ID and a Sign in
with Apple key in their Apple Developer account, the Gateway holds the
Services ID and a client secret signed with that key, and they have signed
in with Apple once. `pnpm everyapp signin show apple --json` names this
file as `setup`, and the CLI prints
`Guide: .claude/skills/everyapp/setup/signin-apple.md`.

Who gets in doesn't change: Apple only says who someone is. A member signs
in; someone with a pending invitation for that exact address joins with
the invited role; everyone else is refused ("You don't have an account on
this gateway.") and nothing is created. Someone who picks **Hide My
Email** on Apple's sheet arrives as a `@privaterelay.appleid.com` address
that no invitation names: ask them to pick **Share My Email**, or invite
the relay address. The rules: `docs/runbooks/sign-in-providers.md`.

Apple differs from the others twice. The client secret is not copied from
a page: it is a JWT you sign with the key, valid six months at most, so
it must be generated again before then or sign-in stops. And Apple returns
to the Gateway with a POST; behind Cloudflare Access, `everyapp access on`
leaves `/api/auth/callback/apple` open for it (Verify 4).

## Settings

| Name                         | Required | Flag                             | What it holds                                                                 |
| ---------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `APPLE_SIGNIN_CLIENT_ID`     | required | `--client-id <id>`               | the Services ID's identifier (`com.example.gateway`); not a secret            |
| `APPLE_SIGNIN_CLIENT_SECRET` | required | `--client-secret-from-env <VAR>` | the ES256 JWT from step 5; expires within six months                          |

Scopes asked for: `email name`. The email is the ID token's `email`,
counted only when `email_verified` is true.

## Costs and plans

A paid Apple Developer Program membership: US$99 a year (Apple's
fee-waiver page names the 99 USD fee; local prices vary), as an individual
or an organization; enrolling an organization needs a D-U-N-S number and
can take days. Sign in with Apple itself costs nothing more. Only the
Account Holder or an Admin of the team can set up the identifiers.

## Only a person can

- Enroll in the Apple Developer Program and pay.
- Create the App ID, the Services ID and the key in Certificates,
  Identifiers & Profiles, and download the key's `.p8` file (once only).
- Keep the `.p8` file safe: it is the only way to make the next secret.
- Sign in with Apple to check it.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true;
   `data.gatewayUrl` gives `<gateway host>`. Not installed or no owner:
   [gateway.md](gateway.md) first. `data.access.on` true: see Verify 4.
2. `pnpm everyapp signin show apple --json` (changes nothing; `Unknown
   command signin`: `git pull` in the `every-app` folder). `data.status`
   `off`: this file applies; `on`: it works, and only the secret may need
   renewing (Rotate). `data.callbackUrl` is the Return URL,
   `https://<gateway host>/api/auth/callback/apple`.
3. Ask whether they have a paid Apple Developer membership, and their
   Team ID (top right of https://developer.apple.com/account, or
   Membership details: ten characters). The Team ID is not a secret.

## Steps

1. **You:** give the person `<gateway host>` and `data.callbackUrl`.
2. **Person:** the App ID. https://developer.apple.com/account/resources/identifiers/list
   → **+** → **App IDs** → **Continue** → **App** → **Continue** →
   Description (`EveryApp`), Bundle ID **Explicit** (`com.<their domain
   reversed>.everyapp`) → tick **Sign in with Apple** (as a primary App
   ID) → **Continue** → **Register**.
3. **Person:** the Services ID, which is the client id. Same page → **+** →
   **Services IDs** → **Continue** → Description (people see it, for
   example `EveryApp`), Identifier (`com.<their domain reversed>.gateway`;
   not the App ID's) → **Continue** → **Register**. Open it from the list
   (the filter top right switches to **Services IDs**) → tick **Sign in
   with Apple** → **Configure** → Primary App ID: step 2's → the domain
   `<gateway host>` and the return URL `data.callbackUrl` (Apple's help
   calls the field **Website URLs**, a comma-separated list; some screens
   show **Domains and Subdomains** and **Return URLs** apart) → **Done** →
   **Continue** → **Save**. No file to upload to the domain.
4. **Person:** the key. https://developer.apple.com/account/resources/authkeys/list
   → **+** → Key Name (`EveryApp sign-in`) → tick **Sign in with Apple**
   → **Configure** → step 2's App ID → **Save** → **Continue** →
   **Register** → **Download** (one chance: the file is
   `AuthKey_<Key ID>.p8`, in Downloads) → **Done**. The Key ID is in the
   file name and on the key's page. They tell you the Key ID, the Services
   ID, the Team ID and the file's full path (none of these is a secret;
   the file's contents are, and nobody opens it). Labels in this step are
   from Apple's general key steps plus the runbook (unverified on Apple's
   Sign in with Apple key page, which was missing when checked).
5. **You:** make the secret and set both at once, from the `every-app`
   folder, in bash or zsh. The JWT goes straight into an environment
   variable of the `signin add` process: it never appears on screen, on a
   command line or in history. Never run the inner command on its own (it
   prints the JWT) and never open the `.p8`. The key path must be absolute
   (the command runs inside `packages/sdk`, which is where `jose` resolves).
   ```sh
   APPLE_SIGNIN_CLIENT_SECRET="$(APPLE_KEY_FILE=/Users/<them>/Downloads/AuthKey_<Key ID>.p8 APPLE_KEY_ID=<Key ID> APPLE_TEAM_ID=<Team ID> APPLE_SERVICES_ID=<Services ID> pnpm --filter @every-app/sdk exec node --input-type=module -e "import { importPKCS8, SignJWT } from 'jose'; import { readFileSync } from 'node:fs'; const e = process.env; const key = await importPKCS8(readFileSync(e.APPLE_KEY_FILE, 'utf8'), 'ES256'); process.stdout.write(await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: e.APPLE_KEY_ID }).setIssuer(e.APPLE_TEAM_ID).setSubject(e.APPLE_SERVICES_ID).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('180d').sign(key))")" pnpm everyapp signin add apple --client-id <Services ID> --client-secret-from-env APPLE_SIGNIN_CLIENT_SECRET --json
   ```
   The JWT: header `alg` ES256, `kid` the Key ID; claims `iss` the Team ID,
   `sub` the Services ID, `aud` `https://appleid.apple.com`, `iat` now,
   `exp` 180 days out (Apple's limit is 15777000 seconds, about six
   months). A wrong path or key fails inside `$(…)`, the variable is
   empty and `signin add` stops with `SECRET_EMPTY`: nothing is written.
   The done event's `data.status` is `"on"`.
6. **You:** tell the person to set a reminder for five months from today
   (Rotate), and to move the `.p8` out of Downloads into a password
   manager or another safe place outside the repository: Apple never lets
   it be downloaded again.

## Verify

1. `pnpm everyapp signin list --json`: the `apple` entry has `status:
   "on"` and `missing` empty.
2. The person's Apple ID address must be a member's or have a pending
   invitation: `pnpm everyapp workspace invite <email>` for someone new.
3. **Person:** private window, `https://<gateway host>/sign-in` →
   **Continue with Apple** → sign in with the Apple ID → **Share My
   Email** → **Continue** → the Gateway, signed in.
4. Behind Cloudflare Access: the Apple address must be the one Access
   knows the person by, and Access must let Apple's POST through. Run
   `pnpm everyapp access show --json`: `data.applications.gateway.inSync`
   false means the ring predates the Apple bypass; `pnpm everyapp access on --json`
   adds it (also after `pnpm everyapp update`). A ring made by hand without
   that bypass blocks Apple sign-in.
5. Logs (README's Verify 4): `signin.config_problem` for a malformed or
   missing setting.

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| no **Continue with Apple** button | a setting missing or malformed, or the version isn't live yet | `pnpm everyapp signin list --json`; logs' `signin.config_problem` |
| Apple's page says the redirect URL or client is invalid (wording unverified) | the Return URL isn't exactly `data.callbackUrl`, or the client id isn't the Services ID | step 3; the client id is the Services ID's identifier, not the App ID |
| `invalid_client` after Apple's sheet | the JWT is expired, signed with another key, or names another Team ID, Key ID or Services ID | step 5 again with the right values (Rotate) |
| works for months, then stops | the JWT expired | Rotate |
| Access's login page, or a 403, right after Apple's sheet | the outer ring blocks Apple's POST to `/api/auth/callback/apple` | `pnpm everyapp access on --json` |
| "You don't have an account on this gateway." | the address (often a `@privaterelay.appleid.com` one) isn't a member's or invited | **Share My Email**, or invite the address Apple returns |
| `SECRET_EMPTY` | the JWT command failed (path not absolute, wrong file, a typo in an id) | run step 5 again with corrected values; its stderr says what failed |
| `SIGNIN_VALUE_REQUIRED` | unattended, and the client id is neither given nor set | `data.rerun`, with `--client-id <Services ID>` |

## Rerun, rotate, remove

- Rerun: step 5 any time; values given replace, settings not given are
  kept.
- Rotate, before six months pass: the same command with the same `.p8`,
  leaving out `--client-id` (it is kept), or pipe the JWT into the one
  setting (same environment variables and `node … -e "…"` as step 5):
  `APPLE_KEY_FILE=… pnpm --filter @every-app/sdk exec node --input-type=module -e "…" | pnpm everyapp secret set APPLE_SIGNIN_CLIENT_SECRET --json`.
  A lost `.p8`: the person makes a new key (step 4), revokes the old one,
  and step 5 runs with the new Key ID.
- Remove, only when asked: `pnpm everyapp signin remove apple --json --yes`
  (`--yes` only when they said so). Accounts made with it stay. Then the
  person revokes the key and deletes the Services ID in Apple's console.

## Sources

- https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
  (the JWT's header and claims; at most 15777000 seconds; the page didn't
  render when fetched, so the claim list is checked against the runbook
  and the test below)
- https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web
  (Services ID → Sign in with Apple → Configure → primary App ID → Website
  URLs → Done → Continue → Save; no domain file)
- https://developer.apple.com/help/account/capabilities/about-sign-in-with-apple
  (primary App ID; Account Holder or Admin)
- https://developer.apple.com/help/account/keys/create-a-private-key
  (Keys → +; download once, `.p8` in Downloads)
- https://developer.apple.com/support/fee-waiver (the 99 USD yearly fee)
- Step 5's command was run on 2026-10-24 against a throwaway P-256 key:
  the JWT verified with `jose` (ES256, `kid`, `iss`, `sub`, `aud`, `exp -
  iat` = 15552000), and pnpm prints nothing else on stdout.
- `docs/runbooks/sign-in-providers.md` ("Apple") and
  `packages/sdk/src/internal/signInProviders.ts`
