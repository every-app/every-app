# Cloudflare Access for the Gateway

Read [README.md](README.md) first: the rules every setup follows.

Cloudflare Access puts a second door in front of the Gateway and every app
host (`<app>.<app base domain>`: OpenSEO, Open CRM, OpenAnalytics,
openmail, any app made with `everyapp create`), at Cloudflare's edge:
nobody reaches them before Access has checked who they are, with their
Cloudflare account (members of the operator's Cloudflare account) or a
one-time code emailed to them, and asked the Gateway whether that person is
a member or invited. `pnpm everyapp access on` does it all from the
Cloudflare login, in one fixed recipe: the Zero Trust team, both sign-in
methods (Sign in with Cloudflare and the one-time PIN), one allow policy
whose rule asks the Gateway who is a member (External Evaluation), two
Access applications, and the three Gateway settings. Invitations need no
rerun. MCP clients, the Gateway's `/health` and each app's public routes
stay reachable without it.

`pnpm everyapp setup` does the same by default once the owner exists: a
person at a terminal is asked ("Put Cloudflare Access in front of your
Gateway?", Yes by default); under `--json` or `--yes` it goes on without a
question, and an account with no Zero Trust team stops the run on
`ACCESS_TEAM_REQUIRED`: the person picks the name (step 1 below), then
setup runs again with `--team <name>`. A failure there is
`ACCESS_SETUP_FAILED`, and setup run again picks up at Access. Only
`setup --no-access`, a No at the terminal, or an earlier `access off`
leaves it off: remembered in the Gateway's D1 (`access on` forgets it),
with the warning `ACCESS_SETUP_SKIPPED` that it isn't recommended. Never
pass `--no-access` unless the person asks.

## Settings

All three written by `everyapp access on`; nothing to type. Values can't be read back.

| NAME                            | required or optional | what it holds                                                                                                        |
| ------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | required             | the Zero Trust team's domain, `<team>.cloudflareaccess.com`                                                          |
| `CLOUDFLARE_ACCESS_AUD`         | required             | the AUD tag of the Access application on `<gateway host>`; only its tokens sign people in                            |
| `CLOUDFLARE_ACCESS_APPS_AUD`    | required             | the AUD tag of the Access application on `*.<app base domain>`; its tokens only vouch for a session on an app host   |
| `EMAIL_PASSWORD_SIGN_IN`        | optional             | `false` turns passwords off once an owner has signed in through Access; unset or `true` keeps them. Not a secret     |

## Costs and plans

As of October 2026: Cloudflare's Zero Trust Free plan costs nothing and
covers 50 users; once the seats are used, the next person to sign in is
blocked. Beyond that, pay-as-you-go is $7 per user per month. Every person
who signs in through Access uses a seat; the bypassed paths and service
tokens use none. Cloudflare's dashboard onboarding
(https://one.dash.cloudflare.com) asks for payment details even on the Free
plan and says it won't charge; `access on --team` makes the team through
the API without it. The login page is `<team>.cloudflareaccess.com`. An
Access session lasts one month (`720h`); a one-time PIN expires 10 minutes
after it is sent. The External Evaluation rule the policy uses is on every
plan.

## Only a person can

- Choose the Zero Trust team name: `<name>.cloudflareaccess.com` is the sign-in page. Changing it later frees the old name for anyone and breaks the Gateway until `pnpm everyapp access on --json` runs again: better avoided.
- Approve the Cloudflare login in the browser (the Access permissions come with it).
- Sign in through Access: with their Cloudflare account, or the code that lands in their inbox.
- Decide whether passwords go.
- Ask for `access off` or `secret unset`; you never run them unasked.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true (claimed means an owner exists; `on` refuses before that with `ACCESS_NOBODY_ALLOWED`); `data.mode` is `self_hosted` (a hosted Gateway refuses `on`: `ACCESS_HOSTED`); `data.gatewayUrl` gives `<gateway host>`. `data.access` is `{ on }`: `on` true means the Worker holds all three settings, so Access is on already, go to Verify. `data.access` null means a hosted Gateway, no Worker yet, or that cf couldn't read the settings (`ACCESS_UNKNOWN` in `data.fixes`). Not installed or no owner: [gateway.md](gateway.md) first. `action_required cloudflare_login` with `waiting: true`: show `data.url` and `data.code`, keep reading. Several accounts: add `--account-id <account id>` to every command.
2. `pnpm everyapp access show --json` (changes nothing): `data.team` null means the account has no Zero Trust team and `on` will need `--team`.
3. Apps with public routes (a tracking script, a webhook): `on` reads them from the deployed manifests, and later deploys keep them current. `status --json` lists each app's as `data.apps[].publicRoutes`.

## Steps

1. **You, then the person:** the team name, when `data.team` was null. The person chooses it: lowercase letters, digits and dashes, like the company's name. Say that `https://<name>.cloudflareaccess.com` is where everyone signs in, and that names are shared across Cloudflare (a taken one fails). Wait for the name.
2. **You:** turn it on. Nothing to `secret set`: `on` writes the three settings itself, in one new Worker version.
   ```sh
   pnpm everyapp access on --json
   ```
   Add `--team <name>` when step 1 chose one (ignored once a team exists). In the `done` event read `data.team.domain` and `data.team.created`, `data.signInMethods`, `data.policy.outcome`, `data.applications.gateway.outcome` and `data.applications.apps.outcome` (`created`, `updated`, `unchanged`) and `data.signIn.url`. Relay every `warning` (codes under If it fails). Don't print the AUD tags.
3. **Person:** each member signs in through Access. Give them these lines, the buttons' labels as written:
   1. Open `https://<gateway host>`; Access's page on `https://<team>.cloudflareaccess.com` opens, with **Sign in with Cloudflare** and the email field.
   2. A member of the Cloudflare account whose Cloudflare email is their Gateway address selects **Sign in with Cloudflare**. Everyone else types the email and selects **Send login code**, then pastes the code from the email (sender `noreply@notify.cloudflare.com`; it lasts 10 minutes) and selects **Sign in**.
   3. They land in the Gateway, signed in. An invited person joins as they arrive, without a password.
4. **You:** only when the person asks, turn passwords off. Not a secret, so it may be piped:
   ```sh
   echo false | pnpm everyapp secret set EMAIL_PASSWORD_SIGN_IN --json
   ```
   The Gateway applies it only once an owner has signed in through Access, so it can't lock the owner out; `echo true | ...` turns passwords back on.
5. **Later:** inviting someone needs nothing in Access: invite them in the Gateway, with the address Access will see, and they can sign in at once. Taking someone off is Deactivate in the Gateway (**Manage workspace → Users → ⋯ → Deactivate**), which ends their sessions, tokens and AI connections; Access turns them away at their next Access sign-in. A deploy that changes an app's public routes updates Access itself (`app.access`); if it warns `ACCESS_UPDATE_FAILED`, run `pnpm everyapp access on --json`.

## Verify

1. `pnpm everyapp status --json`: `data.access` is `{ "on": true }` (the human report's row: `Access  on · everyone signs in through Cloudflare Access first`), and no `ACCESS_UNKNOWN` in `data.fixes`.
2. `pnpm everyapp access show --json`: `data.on` true, `data.policy.asksGateway` true, `data.settings.names` lists all three, both applications present, no `data.fixes`. Then `GET https://<gateway host>/health` answers `200 {"status":"ok"}` with no login.
3. Smoke check, from your shell: a bypassed path answers the Gateway, the rest answers Access.
   ```sh
   curl -sS -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}\n' https://<gateway host>/access-evaluation/keys
   curl -sS -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}\n' https://<gateway host>/ | sed -E 's/kid=[^&]*/kid=…/'
   ```
   Expected: the first `200 application/json` (the key Access checks the Gateway's answers with); the second `302` to `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...`. HTML or a redirect on the first means a bypass is missing: `pnpm everyapp access on --json`.
4. **Person:** open `https://<gateway host>` in a private window (Access's page first, then the Gateway signed in), then `https://<app>.<app base domain>`; ask whether the app opened with no second sign-in page. An AI app connected over MCP keeps working.
5. Logs: **Workers & Pages** → `every-app-gateway` → **Observability** → **Live**. `access.evaluated` with `member` is Access asking the Gateway; `access.evaluation_refused` a call the Gateway couldn't verify; `access.config_problem` names a malformed setting; `access.jwks_fetch_failed` means the team's keys couldn't be fetched.

## If it fails

| error or symptom | meaning | what to do |
| --- | --- | --- |
| `ACCESS_PERMISSION_MISSING` | the Cloudflare login or token can't manage Access | `cf auth logout`, then the next command logs in again with the Access permissions; a token needs Access: Apps and Policies (edit) and Access: Organizations, Identity Providers, and Groups (edit) (`data.url`) |
| `ACCESS_NOBODY_ALLOWED` | the Gateway has no owner yet | claim it first ([gateway.md](gateway.md)), then rerun |
| `GATEWAY_OUTDATED` | the live Gateway can't answer Access's membership question yet | `pnpm everyapp update`, then rerun |
| `ACCESS_TEAM_REQUIRED` | no Zero Trust team and no terminal to ask at | ask the person (step 1); rerun with `--team <name>` |
| `ACCESS_TEAM_INVALID` | not lowercase letters, digits and dashes | another name |
| `ACCESS_TEAM_CREATE_FAILED` | Cloudflare refused the team (usually a taken name) | another `--team` |
| `ACCESS_HOSTED` | a hosted Gateway ignores Access | not available there |
| warning `ACCESS_ROUTE_NOT_EXPRESSIBLE`, `ACCESS_TOO_MANY_PUBLIC_ROUTES` | a public or bearer route stays behind Access: no Access pattern for it, or past 25 per host | people signed in to Access still reach it; the app's author merges routes under one prefix |
| warning `ACCESS_APP_OUTSIDE_BASE` | the app's host isn't one label under `<app base domain>`, so Access isn't in front of it | the person moves the app under the base domain |
| warning `ACCESS_UPDATE_FAILED` after a deploy, delete or update | the command succeeded, but Access wasn't updated (`data.cause`; often a login that can't edit Zero Trust) | `pnpm everyapp access on --json` |
| `ACCESS_UNKNOWN` in `status --json`'s `data.fixes` | cf couldn't read the Gateway Worker's secret names | run `status` again |
| Access's page: "That account does not have access." | the Gateway answered no: not a member, not invited, or deactivated | invite them in the Gateway with that address |
| the page said "A code has been emailed to you", no code arrives | mistyped address, or a mail gateway blocks the mail | check the address; ask the person's mail admin |
| "This gateway signs people in through Cloudflare Access, and this request didn't come through it." | wrong AUD tag (an application recreated by hand), or Access isn't in front of that host | `pnpm everyapp access on --json` |
| "You're signed in to Cloudflare Access as X, but this account is Y" | behind Access a browser is only the person Access says | **Not you? Sign out of Access** on that page, then sign in as the right person |
| apps send people back to the sign-in page | `CLOUDFLARE_ACCESS_APPS_AUD` doesn't match the apps' application | `pnpm everyapp access on --json` |
| an app's webhook or public page gets Access's login | its public routes changed since the last `on` | `pnpm everyapp access on --json` |
| nobody gets past Access, everyone refused | the Gateway isn't answering Access's question (down, or `access.evaluation_refused` in the logs) | check `/health`; `access show` says whether the policy still asks the Gateway; `access on` puts it back; when the person asks, `pnpm everyapp access off --json` gets everyone in through the Gateway's own sign-in |
| the 51st person is blocked by Access | the Free plan's 50 seats | the person removes a user in Zero Trust or moves to pay-as-you-go |
| `CONFIRMATION_REQUIRED` | `access off` or `secret unset` under `--json` without `--yes` | add `--yes` only when the person said so |

## Rerun, rotate, remove

- Rerun: `pnpm everyapp access on --json` any time; it changes only what differs in Access and writes the three settings again (one new Worker version). `deploy`, `delete` and `update` run it themselves while Access is on; run it after `ACCESS_UPDATE_FAILED` and after a change by hand. Never needed for an invitation.
- Rotate: nothing here is a secret. To end every Access session: dashboard **Zero Trust → Access controls → Applications → Configure → Revoke existing tokens**, or, when the person asks, `cf zero-trust access applications revoke-tokens <id>` for both ids in `access show --json`.
- Remove: `pnpm everyapp access off --json` (asks; `--yes` only when the person said so). The choice is remembered: a later unattended `setup` leaves Access off, with the warning `ACCESS_SETUP_SKIPPED`, until `access on` runs again. It removes the three settings first, then deletes the two applications; the team, its sign-in methods and the policy stay.

## Sources

- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/external-evaluation/ (the External Evaluation rule: evaluate URL, keys URL, the signed answer and its nonce)
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ (selectors: External Evaluation checked at login; only User Risk Score is Enterprise-only)
- https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/ (the PIN page, "Send login code", the sender, 10 minutes)
- https://developers.cloudflare.com/cloudflare-one/setup/ (team name, plan, payment details on the Free plan, https://one.dash.cloudflare.com)
- https://www.cloudflare.com/plans/sase-zero-trust/ (Free: 50 users; pay-as-you-go $7 per user per month)
- https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/ (sessions up to one month, revoking tokens)
- https://dash.cloudflare.com/profile/api-tokens (where a token gets the Access permissions)
- `docs/runbooks/cloudflare-access.md`, `landing-page/content/agent/access.md`, `packages/cli/src/commands/access/`, `packages/cli/src/lib/access/`, `apps/every-app-gateway/src/server/access-evaluation.ts`
