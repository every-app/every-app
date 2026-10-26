# Google (Gmail, Calendar, Search Console and Analytics OAuth client) for the Gateway

One OAuth client in a Google Cloud project the person owns, held by the
Gateway, lets each member of an app connect their own Google account, read
only: Gmail, Google Calendar, Search Console and Google Analytics, whichever
of the four an app declares. The Gateway completes Google's token endpoint
with the client; the app builds the authorize URL from the public client
id, keeps the member's tokens and reads Google's APIs itself. Open CRM (app
id `crm`) uses it for Gmail and Calendar: Settings → Connections →
Google Workspace (`/settings/connections/google`), through its own
callback. OpenSEO (app id `openseo`) uses it for Search Console and
Google Analytics through the Gateway's own flow: it declares the sets
`identity`, `search-console.read` and `analytics.read`, and each person
connects under Connected accounts (the redirect URI
`https://<gateway>/connect/google-workspace/callback`). At the end the person
has a Cloud project with the APIs behind the declared sets enabled (for
Open CRM: the Gmail API and the Google Calendar API; for OpenSEO: the
Search Console API and the Analytics Admin and Data APIs), a consent screen
listing their scopes, a Web application client whose redirect URI is the
app's callback, and both settings on the Gateway. A Gateway-held token broker for
organization Google accounts is not built (the direction is in `docs/hosted-vision.md`); the scope sets
below come from `docs/design/2026-10-oauth-scopes.md`.

## Settings

Through the Gateway's own flow (since 2026-10-25) the same client also serves apps that list `google-workspace` with `access: "read"` and `scopes`, without an app callback: register `https://<gateway>/connect/google-workspace/callback` as a second redirect URI, and each person connects under Connected accounts in the account menu (the agent docs' `providers` page, "OAuth providers"). The client may be pasted in Manage workspace → Providers instead of set below; a setting set here wins.

| Name                             | Required | What it holds                                                                     |
| -------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `GOOGLE_WORKSPACE_CLIENT_ID`     | required | The client's id, ending in `.apps.googleusercontent.com`; public, not a secret    |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | required | The client's secret, shown once at creation; starts with `GOCSPX-` in practice (secret scanners key on the prefix; Google does not document the format) |

Both belong to the `google-workspace` capability (`packages/sdk/src/internal/capabilities.ts`,
label "Google (Gmail, Calendar, Search Console and Analytics)"). Since #398
(2026-10-24) the client carries five read-only scope sets, each one
provider scope: `identity` (`openid`, `email`, `profile`), `gmail.read`
(`https://www.googleapis.com/auth/gmail.readonly`), `calendar.read`
(`…/auth/calendar.readonly`), `search-console.read`
(`…/auth/webmasters.readonly`) and `analytics.read`
(`…/auth/analytics.readonly`); no write set exists (the table in
`docs/capabilities.md`, "OAuth clients"). The console rule: enable the
APIs and allow on the consent screen the union of the provider scopes
behind the sets of every app you approve, not the registry's full list. A
scope no app asks for needn't be on the consent screen, and Google's
verification follows what is listed: `gmail.readonly` is restricted;
`webmasters.readonly` and `analytics.readonly` are sensitive (unverified:
Google publishes no list, the Data Access page labels each scope once
added). For the launch that is Open CRM: `gmail.readonly` and
`calendar.readonly`, with the Gmail API and the Google Calendar API
enabled. For OpenSEO, add `webmasters.readonly` and `analytics.readonly`
and enable the Search Console API and the Analytics Admin and Data APIs:
OpenSEO declares those sets. The person's version of these steps is
https://everyapp.com/docs/providers/google.

An app names its sets in its manifest,
`"google-workspace": { access: "write", scopes: ["gmail.read", "calendar.read"], why }`
(#414; `everyapp deploy` refuses the entry without `scopes`), and the
Gateway holds it to them at every token exchange and refresh (#411, the
design's §5): a token whose granted scopes exceed the sets is refused
(`integration_scope_exceeded`, 403), so apps must not send
`include_granted_scopes=true` (Google then makes the token cover every
scope the person has granted the Cloud project, and a wider grant to
another app on the same project gets the narrower app refused until they
reconnect without the flag); a deployed manifest without `scopes` is
refused too (`integration_scopes_undeclared`, 403). Open CRM declares
both sets and sends no flag; a CRM deployed before that must redeploy
before the Gateway is updated from main (TODO.md "OAuth scopes
(2026-10-24)", follow-up 0). Redirect URI:
`https://<app>.<app base domain>/integrations/google/callback` for every
app that lists the capability; for Open CRM,
`https://crm.<app base domain>/integrations/google/callback`.

## Costs and plans

As of October 2026: a Google Cloud project is free and needs no billing
account for this. Standard use of the Gmail API and the Google Calendar API
is free; Google plans to charge above the quota limits later in 2026. Limits:
Gmail 80,000,000 quota units per day per project, 6,000 per minute per user;
Calendar 1,000,000 requests per day per project, 600 per minute per user;
100 live refresh tokens per Google Account per client (the oldest is dropped
silently). The Search Console API and the Analytics Data API list quotas
and no price (Search Console 1,200 search-analytics queries per minute per
site and per user; Analytics Data 200,000 tokens per property per day on a
standard property): they matter only once an app declares those sets.
*Internal* needs the project in a Google Workspace or Cloud
Identity organization: Workspace Starter lists at about $7 per user per
month, or Cloud Identity Free costs nothing and creates the organization
once the person verifies a domain they own (a DNS TXT record, recognized
within 72 hours; then continue at step 2). *External* with `gmail.readonly`
needs Google's restricted-scope verification (several weeks of review, by
email) plus a yearly CASA security assessment by a third-party assessor:
Google's Health page quotes $500 to $4,500 depending on the app's
complexity, and 2 to 3 weeks for the lower tier, 4 to 6 for the higher
(the CASA page now calls them AL1 and AL2). Sensitive scopes alone (Search
Console and Analytics without `gmail.read`) need the verification and no
assessment.

## Only a person can

- Sign in to Google, create the Cloud project and pick its organization.
- Accept the Google API Services User Data Policy on the consent screen.
- Create the OAuth client and download its JSON: no API or gcloud command
  creates a Web application client (step 6).
- Add test users, publish the app, submit verification, pay an assessor.
- Click Connect in Open CRM and approve the consent screen with their account.
- Allow the app in the Workspace admin console when `admin_policy_enforced`.

## Before you start

1. `pnpm everyapp secret list crm --json`, from any directory (the id reads
   the manifest Open CRM's last deploy stored; in its directory the id can
   be left off), one call, before any Google step. The rule: read
   `data.app.setup.settings`, `unmet` and `command`. The client is one
   setting there, `id: "google-workspace"`, `kind: "capability"`, `holder:
   "gateway"`, `names: ["GOOGLE_WORKSPACE_CLIENT_ID",
   "GOOGLE_WORKSPACE_CLIENT_SECRET"]` (an OAuth client's id and secret are
   the two names of one setting, set only when both are), `need.kind` as
   the CRM's manifest declares it (Open CRM: `optional`: it sits in
   `settings` with `set: false`, never in `unmet`, the CRM opens without
   Gmail and Calendar and `command`, `pnpm everyapp configure crm`, offers
   it after the required ones; `required` would put it in `unmet`, close
   the CRM and have configure ask for both names first), `setup:
   "setup/google.md"` (this file). While its `set` is false this file
   applies. The same entry in
   `data.app.setup.settings` with `set: true`: ask before replacing (a new
   secret for the same client is harmless, see Rotate; a different client
   id makes every member reconnect Gmail and Calendar).
   `TOKEN_ENCRYPTION_KEY`, the CRM's own secret that connecting needs, is
   in `settings` too (`holder: "app"`; optional, so never in `unmet`): the
   CRM's admin sets it after the CRM's first deploy, at the hidden prompt
   of `pnpm everyapp configure crm` (which offers it with the optional
   ones) or `pnpm everyapp secret set TOKEN_ENCRYPTION_KEY --app crm`, from
   anywhere, 32 or more random characters (the CRM refuses shorter); a
   missing key shows at step 9, the table's last row. `APP_NOT_FOUND`:
   deploy Open CRM first (its callback must answer before anyone
   connects).
2. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true,
   `data.appBaseDomain` is `<app base domain>` (step 1 builds the redirect
   URI from it), and `data.apps[]` has `id: "crm"` with `status: "active"`
   and `bound: true`. Its `setup` is 1's `data.app.setup` again and says
   what else the CRM needs; not installed, or no owner:
   [gateway.md](gateway.md) first.
3. Ask whether a Cloud project or a Web client exists for this already:
   then step 6 adds the redirect URI to it. Never reuse OpenSEO's verified
   client (the design doc's rule). The sets the apps declare decide steps
   3 and 5: Open CRM, `gmail.read` and `calendar.read`; OpenSEO,
   `search-console.read` and `analytics.read` (with the Gateway's redirect
   URI `https://<gateway>/connect/google-workspace/callback`, step 6).
4. Ask whether every member who will connect is in one Google Workspace
   organization. Yes: *Internal*, no verification. No: *External* (step 7).
   A member on a gmail.com account is outside any organization: *External*.
   Wait for both answers before giving the steps: they decide step 2's
   Location, step 4's Audience and whether step 7 applies.

## Steps

Once the audience is known, steps 2 to 6 (and 7 for *External*) can go to
the person in one message, with step 1's URI; then wait for the file
before step 8.

1. **You:** work out the redirect URI from `data.appBaseDomain`:
   `https://crm.<app base domain>/integrations/google/callback`. Open CRM's
   Settings → Connections → Google Workspace page, signed in as an owner or
   admin (members see no setup rows), shows the same value under "Redirect
   URI" while the Gateway holds no client. Give it to the person for step 6.
2. **Person:** signed in to Google with the Workspace account (a gmail.com
   account shows no organization), create the project at
   https://console.cloud.google.com/projectcreate: Project name (for example
   `EveryApp`), Location → Browse → the Workspace organization (needed for
   *Internal*; "No organization" otherwise) → Create. Done when the
   project's dashboard opens with its name in the top bar. With gcloud
   (checked against the reference today, not run here): the person runs
   `gcloud auth login` (opens a browser), then
   `gcloud projects create every-app-gateway-<4 digits> --name="EveryApp" --set-as-default`
   (any unused id: ids are global and never reusable, so a taken one is
   refused; add `--organization=ORGANIZATION_ID` for *Internal*, the number
   from `gcloud organizations list`).
3. **Person:** enable the APIs behind the declared sets; for Open CRM, two:
   open
   https://console.cloud.google.com/apis/enableflow;apiid=gmail.googleapis.com
   → Enable, then
   https://console.cloud.google.com/apis/enableflow;apiid=calendar-json.googleapis.com
   → Enable (or APIs & Services → Library → Google Workspace → each API →
   Enable). Done when each shows "API Enabled". With gcloud (checked against
   the reference): `gcloud services enable gmail.googleapis.com calendar-json.googleapis.com`.
   Only for an app that declares `search-console.read` or `analytics.read`,
   the same with `searchconsole.googleapis.com` (Google Search Console
   API), `analyticsadmin.googleapis.com` (Google Analytics Admin API) and
   `analyticsdata.googleapis.com` (Google Analytics Data API): the service
   ids are the APIs' own hosts (their discovery documents, Sources).
4. **Person:** configure the consent screen at
   https://console.cloud.google.com/auth/overview → Get Started. App
   Information: App name (what members see, for example `EveryApp`), User
   support email → Next. Audience: *Internal* (only that Workspace's
   accounts, no verification) or *External* → Next. Contact Information: an
   email for Google's notices → Next. Finish: agree to the User Data Policy
   → Continue → Create. Done when the Google Auth platform overview shows
   the app.
5. **Person:** add the scopes on the Data Access page,
   https://console.cloud.google.com/auth/scopes → Add or remove scopes →
   filter `gmail.readonly` and `calendar.readonly`, tick both → Update →
   Save; `webmasters.readonly` and `analytics.readonly` too, only for an
   app that declares those sets, never a scope no app asks for. Only the
   scopes of enabled APIs are listed: a missing one means step 3, or paste
   its URL under "Manually add scopes". `gmail.readonly` is a restricted
   scope, `calendar.readonly` a sensitive one (the page labels the other
   two once added). Done when each is listed under "Your restricted
   scopes" or "Your sensitive scopes".
6. **Person:** create the client at https://console.cloud.google.com/auth/clients
   → Create client → Application type: Web application → Name (for example
   `EveryApp Gateway`) → Authorized redirect URIs → Add URI → paste the exact
   URI from step 1 → Create. No Authorized JavaScript origins. A dialog shows
   the Client ID and the Client secret once (afterwards only its last four
   characters). Click Download JSON; browsers save it as
   `client_secret_….json`, in `~/Downloads` unless set otherwise, outside
   the repository. The person tells you it is there, and where when it
   isn't in `~/Downloads`. No command does this: the IAP OAuth Admin API that
   created clients was shut down on 2026-03-19, and
   `gcloud iam oauth-clients create` makes Workforce Identity Federation
   clients, not Google Account clients. URI changes take 5 minutes to a few
   hours to apply.
7. **Person,** *External* only: https://console.cloud.google.com/auth/audience
   → Test users → Add users → each member's Google email (up to 100) → Save.
   In Testing every consent expires after 7 days: members reconnect weekly.
   Publish app moves to In production: the unverified-app screen and a
   lifetime cap of 100 new users until verification (plus the CASA
   assessment for `gmail.readonly`) passes. Verification (after Publish
   app: Prepare for Verification → Submit for Verification) needs a home
   page and a privacy policy on a domain the person owns, listed under
   Authorized domains and verified in Search Console by a project owner or
   editor, a demo video of the consent flow and a written scope
   justification; Google answers by email over several weeks. Until then
   stay in Testing (weekly reconnects, 100 test users); the run resumes at
   Verify when Google's mail comes. Skip for *Internal*.
8. **You,** only after the person says the file is there: the README's "a
   command produced it" way, pipe each value from the file, never read the
   file yourself. `ls ~/Downloads/client_secret_*.json` (or the folder they
   named): more than one file, ask which (the newest:
   `ls -t ~/Downloads/client_secret_*.json | head -1`), and use that one
   path below, never the glob (`jq` prints one value per matching file).
   `jq -e 'has("web")' <path>` (`true`; `false` is a Desktop client's file:
   step 6 again). Then
   `jq -r .web.client_id <path> | pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID --json`
   and
   `jq -r .web.client_secret <path> | pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_SECRET --json`.
   Each ends with a `done` event whose `data.gateway.names` holds the name
   (`client_id`, `client_secret`, `redirect_uris`, `auth_uri` and
   `token_uri` are all mandatory under `web`). Then tell the person the
   file still holds the secret and ask them to delete it (or ask before
   running `rm` on it).
   Alternative, the person types it: in their own terminal in the every-app
   folder, `pnpm everyapp configure crm` (it asks for the client's two
   names, id then secret, with hidden prompts, after the CRM's required
   settings; the client is optional for Open CRM, so Yes to `Set the N
   optional settings too?`, Enter skipping the others; with one of
   the two names set it asks only for the other; or pick
   `GOOGLE_WORKSPACE_CLIENT_ID + GOOGLE_WORKSPACE_CLIENT_SECRET` from the
   menu once the CRM is ready) or
   `pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET`
   (two hidden prompts, just these), then they tell you.
9. **Person,** once `data.app.setup.ready` is true: while another required
   setting of the CRM is unmet, the Gateway shows the CRM as "Needs setup"
   and opens its setup dialog instead of the app, so finish those first
   (each `unmet` entry's `setup` names its file); the Google client itself
   is verified by Verify 1 meanwhile. Then open
   https://crm.<app base domain>/settings/connections/google
   (Settings → Connections → Google Workspace) → Connect → choose the
   account → (Testing: "Google hasn't verified this app" → Advanced → Go to
   EveryApp (unsafe)) → Allow. Done when the page shows the "Connected"
   badge with their address. Wait for that.

## Verify

1. `pnpm everyapp secret list crm --json`, from anywhere: the
   `google-workspace` setting has `set: true` (optional for Open CRM, so
   it was never in `data.app.setup.unmet`; a manifest that requires it has
   it leave `unmet`, with `ready: true` and `command` null once nothing
   else is missing); both names in `data.gateway.names`,
   their `data.gateway.needed` entries `"set": true`, and
   `data.gateway.missing` doesn't list them. Then
   `pnpm everyapp status --json`: the `crm` entry's `setup.ready` is true
   and `data.fixes` has no `APP_NEEDS_SETUP` for it (the Gateway opens the
   CRM again).
2. Smoke check, in the person's browser. 2 and 3 need the CRM open: 1's
   `data.app.setup.ready` true. While another required setting is unmet,
   the Gateway sends a browser to its setup dialog instead of the CRM
   (anything else gets 503 `app_needs_setup`): finish those first (each
   `unmet` entry's `setup` names its file); until then 1 is the check of
   the Google client. Then, signed in as an owner or admin (no secret
   involved): Open CRM's Settings → Connections → Google Workspace shows a
   Connect button and the "Not connected" badge instead of "Not
   configured" with the "Redirect URI" and "Command" rows (a plain member
   never sees those rows). The button means the Gateway answered
   `ready: true` with the client id for `google-workspace`.
3. App check: step 9. Google's account chooser means the client id and
   redirect URI match; the "Connected" badge means the Gateway completed
   `POST oauth2.googleapis.com/token` with the secret. Mail and meetings
   appear on companies after the first sync.
4. Logs: the dashboard, README's path:
   **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**
   (the stored Workers Logs are on the same page); filter
   `capability: "google-workspace"`. Each token call is one
   `integration.proxy.call` line with `grantType` (`authorization_code` on
   connect, `refresh_token` on refresh) and `status`, never the body.

## If it fails

| Error or symptom | Meaning | What to do |
| --- | --- | --- |
| `SECRET_VALUE_REQUIRED` | Nothing was piped and there is no terminal | Use the pipe in step 8 or the person's terminal |
| `SECRET_VALUE_REQUIRED` from `pnpm everyapp configure crm --json` | Nothing was piped (with `--from-env`, stdin isn't read), no variable of a missing name was found, and there is no terminal; the message names what the CRM still needs (this client is optional for Open CRM, so never among them) | The pipes in step 8, or the person's terminal (step 8's alternative) |
| `SECRET_SEVERAL_NAMES` | A pipe or `--from-env` with two names | One `secret set` per name |
| `SECRET_NOT_DECLARED` with `data.didYouMean` | Name typed wrong | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| `has("web")` prints `false`; `jq -r .web.client_id` prints `null` | A Desktop client's file (`installed` key); `null` must never be piped | Create a Web application client; unset anything set from it |
| App: "Not configured", "Redirect URI" and "Command" rows, no Connect | The Gateway's status for `google-workspace` answers `ready: false`: it holds no client (or one name only), or the deployed manifest lists the client without `scopes` | Step 8 (or add `scopes` and deploy); then reload |
| `integration_not_configured` (503) in the app's logs | A token call while the Gateway holds no client, or the name is wrong | `secret list --json`; set both names |
| `capability_not_requested` (403) | The deployed manifest doesn't list `google-workspace` | Add `"google-workspace": { access: "write", scopes: ["gmail.read", "calendar.read"], why }` to everyapp.config.ts, deploy |
| `integration_scopes_undeclared` (403) | The deployed manifest lists the client without `scopes` (a deploy from before #414) | Add `scopes: ["gmail.read", "calendar.read"]` to the entry, deploy |
| `integration_scope_exceeded` (403) | Google granted more than the app's sets: the app asked for a scope outside them, or sent `include_granted_scopes=true` and the member had granted a wider scope to another app on this project | The app asks for only the status's scopes without the flag and the member connects again, or the set is added to everyapp.config.ts and deployed; the token was dropped, nothing to revoke |
| `integration_path_not_allowed` (403) | The app called something other than `POST /token` through the Gateway | App bug: API calls go to Google directly |
| Google "Error 400: redirect_uri_mismatch" | The URI on the client differs from step 1 | Fix it on the client; wait up to a few hours |
| Google "Error 401: invalid_client" | Client id or secret wrong, or secret disabled | Rotate (below) and set both again |
| Google "Error 403: access_denied" | The member is not a test user (Testing) | Add them in step 7, retry |
| App: "You didn't give Google access." (`error=access_denied` in the address bar) | The member clicked Cancel on the consent screen | Connect again |
| App: "Google returned an error. Try again." (`error=exchange_failed`) | Google refused with any code but a decline (`admin_policy_enforced`, `org_internal`, a failed token exchange); the CRM's logs say `[mailbox] code exchange failed` with a reason | Read the code in the CRM's logs or on Google's page, then the rows below |
| Google "Error 400: admin_policy_enforced" | The Workspace admin restricts the scopes or the app | A Workspace admin (Service Settings privilege): Admin console → Security → Access and data control → API controls (admin.google.com/ac/owl) → Manage App Access → Configure new app → search the client id → Continue → Trusted → Continue → Finish |
| Google "Error 403: org_internal" | *Internal* audience, account outside the organization | Use a Workspace account, or switch to *External* |
| "Google hasn't verified this app" | *External*, unverified, sensitive or restricted scopes | Advanced → Go to EveryApp (unsafe), or verify |
| Sync stops after 7 days, `invalid_grant` | *External* in Testing: consent expired | Reconnect; publish and verify to stop it |
| `403 accessNotConfigured` ("has not been used in project") | Gmail or Calendar API not enabled in that project | Step 3 in the project the error names; wait a minute |
| Google "Error 401: deleted_client" | The client was deleted (30-day restore window) | Restore it under Deleted credentials, or make a new one |
| Connect fails before Google opens | Open CRM's `TOKEN_ENCRYPTION_KEY` unset | Set it after the CRM's first deploy: `pnpm everyapp configure crm` (which asks for it) or `pnpm everyapp secret set TOKEN_ENCRYPTION_KEY --app crm` from anywhere (in the CRM's directory the flag can be left off), the value in one of README's three ways, 32 or more random characters; connect again |

## Rerun, rotate, remove

- Rerun: every step is safe to repeat. `configure` and `secret set`
  replace; the console shows what exists. After an interruption start at
  Verify and continue at the first step that isn't done.
- Rotate the secret, never the id: a new client id invalidates every
  member's refresh token. Person: Clients → the client → Add secret (two at
  most; both work until one is disabled); the new secret is shown once, and
  they type it at the hidden prompt in their terminal
  (`pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_SECRET`). You verify
  with `secret list --json`; they test Connect; then they Disable the old
  secret, test again, and Delete it.
- Remove: `pnpm everyapp secret unset GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET --json`
  (add `--yes` only when the person said so); every connected mailbox stops
  syncing. Then at Google: Clients → tick the client → Delete (restorable
  for 30 days; Google also deletes clients unused for six months).

## Sources

- https://developers.google.com/workspace/guides/create-project (step 2)
- https://developers.google.com/workspace/guides/enable-apis (step 3)
- https://developers.google.com/workspace/guides/configure-oauth-consent (step 4)
- https://support.google.com/cloud/answer/15549135 (Data Access: only enabled APIs' scopes listed, Manually add scopes; step 5)
- https://support.google.com/cloud/answer/15549257 (clients: secret shown once, two at most, Add secret, 30-day restore, six-month inactivity; steps 6 and 8, Rotate, Remove)
- https://support.google.com/cloud/answer/15549945 (Audience: Internal needs an organization, External, Testing's 100 users and 7 days, Publish app; step 7)
- https://support.google.com/cloud/answer/13464321 (verification: home page, privacy policy, Search Console, demo video, scope justification; restricted scopes alone add the yearly assessment; step 7, Costs and plans)
- https://support.google.com/cloud/answer/9110914 (a scope's category is labeled in the console once added; step 5)
- https://developers.google.com/identity/protocols/oauth2/web-server (`include_granted_scopes`: the token covers every scope the person granted the project; the response's `scope`; Settings)
- https://searchconsole.googleapis.com/$discovery/rest?version=v1, https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta, https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta (service names and the scopes each API takes; step 3)
- https://developers.google.com/webmaster-tools/limits and https://developers.google.com/analytics/devguides/reporting/data/v1/quotas (quotas; Costs and plans)
- `docs/design/2026-10-oauth-scopes.md` (the sets, §4; the token-endpoint check and its codes, §5; §13 what was built), TODO.md "OAuth scopes (2026-10-24)" (Search Console and Analytics on this client; Open CRM's and OpenSEO's follow-ups) and `docs/capabilities.md` "OAuth clients" (the generated sets table; Settings)
- https://support.google.com/accounts/answer/16668185 (Google's sign-in error codes; If it fails)
- https://docs.cloud.google.com/iap/docs/programmatic-oauth-clients (the API that created clients, shut down 2026-03-19; step 6)
- https://developers.google.com/health/app-verification (assessor fees; Costs and plans)
