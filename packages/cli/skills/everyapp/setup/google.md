# Google (Gmail, Calendar, Search Console, Analytics and the other Google APIs) for the Gateway

One OAuth client in a Google Cloud project the person owns, held by the
Gateway, lets each member connect their own Google account inside each app
that lists `google-workspace`, for exactly the scopes that app's
`everyapp.config.ts` names. The Gateway runs the flow on its own callback,
keeps the tokens and puts them on the app's calls to Google's APIs; no app
sees a token or the client. The apps and their scopes today: OpenMail
(app id `openmail`) `["gmail.modify", "gmail.send"]`; Open CRM (`crm`)
`["gmail.readonly", "calendar.readonly"]`; OpenSEO (`openseo`)
`["webmasters.readonly", "analytics.readonly"]`. At the end the person has
a Cloud project with the APIs behind those scopes enabled, a consent screen
listing the scopes, a Web application client whose redirect URI is the
Gateway's `https://<gateway>/connect/google-workspace/callback`, and both
settings on the Gateway. Each connection is one person's in one app: two
apps on this client get separate tokens, each with its own app's scopes.

## Settings

The client may be pasted in Manage workspace → Providers instead of set
below; a setting set here wins.

| Name                             | Required | What it holds                                                                     |
| -------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `GOOGLE_WORKSPACE_CLIENT_ID`     | required | The client's id, ending in `.apps.googleusercontent.com`; public, not a secret    |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | required | The client's secret, shown once at creation; starts with `GOCSPX-` in practice (secret scanners key on the prefix; Google does not document the format) |

Both belong to the `google-workspace` provider, a row the Gateway
registers from its preset (`packages/sdk/src/internal/oauthPresets.ts`)
when an app that lists it is deployed or installed, or with
`pnpm everyapp provider add google-workspace`; until then `secret set`
doesn't know the names. Both names already set as Worker secrets while
the Gateway had no row (an older CLI) are read only once `secret set`
binds them to the row: set them again, or `secret unset` both to use a
client pasted in Admin, which an unbound Worker secret blocks. An app lists Google's own
scopes, short (`gmail.modify`, joined onto
`https://www.googleapis.com/auth/`) or in full:
`"google-workspace": { scopes: ["gmail.modify", "gmail.send"], why }`.
The Gateway adds `openid` and `email` (to name the account) to every
connect, asks Google with `access_type=offline` and `prompt=consent`, and
never sends `include_granted_scopes`. If Google's token answer carries a
scope beyond what the app listed, the token is refused and dropped, at
connect and at every refresh.

The console rule: enable the APIs and allow on the consent screen the union
of the scopes every app you deploy lists, nothing more. A scope no app asks
for needn't be on the consent screen, and Google's verification follows
what is listed: `gmail.readonly`, `gmail.modify` and `gmail.compose` are
restricted; `gmail.send`, `calendar.readonly`, `webmasters.readonly` and
`analytics.readonly` are sensitive (the Data Access page labels each scope
once added). Personal `@gmail.com` accounts need an *External* consent
screen (step 4, step 7; the person's page is
https://everyapp.com/docs/google-personal-accounts). The person's version
of these steps is https://everyapp.com/docs/providers/google.

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
standard property): they matter only once an app lists those scopes.
*Internal* needs the project in a Google Workspace or Cloud
Identity organization: Workspace Starter lists at about $7 per user per
month, or Cloud Identity Free costs nothing and creates the organization
once the person verifies a domain they own (a DNS TXT record, recognized
within 72 hours; then continue at step 2). *External* with a restricted Gmail scope
(`gmail.readonly`, `gmail.modify`) needs Google's restricted-scope verification (several weeks of review, by
email) plus a yearly CASA security assessment by a third-party assessor:
Google's Health page quotes $500 to $4,500 depending on the app's
complexity, and 2 to 3 weeks for the lower tier, 4 to 6 for the higher
(the CASA page now calls them AL1 and AL2). Sensitive scopes alone (Search
Console, Analytics, `gmail.send` or Calendar without a restricted Gmail
scope) need the verification and no assessment.

## Only a person can

- Sign in to Google, create the Cloud project and pick its organization.
- Accept the Google API Services User Data Policy on the consent screen.
- Create the OAuth client and download its JSON: no API or gcloud command
  creates a Web application client (step 6).
- Add test users, publish the app, submit verification, pay an assessor.
- Click Connect in each app and approve the consent screen with their account.
- Allow the app in the Workspace admin console when `admin_policy_enforced`.

## Before you start

1. `pnpm everyapp secret list <app id> --json` for each app that lists
   `google-workspace` (from any directory; in the app's directory the id
   can be left off), before any Google step. Read
   `data.app.setup.settings`, `unmet` and `command`. The client is one
   setting there, `id: "google-workspace"`, `kind: "capability"`, `holder:
   "gateway"`, `names: ["GOOGLE_WORKSPACE_CLIENT_ID",
   "GOOGLE_WORKSPACE_CLIENT_SECRET"]` (the two names of one setting, set
   only when both are), `need.kind` as the app's manifest declares it
   (`optional`: in `settings` with `set: false`, never in `unmet`, and
   `pnpm everyapp configure <app>` offers it after the required ones;
   `required`: in `unmet`, the app closed until both are set), `setup:
   "setup/google.md"` (this file). While its `set` is false this file
   applies. With `set: true`: ask before replacing (a new secret for the
   same client is harmless, see Rotate; a different client id makes every
   member connect again in every app). `APP_NOT_FOUND`: deploy the app
   first.
2. `pnpm everyapp status --json`: `data.installed` and `data.claimed` true,
   and the Gateway's host (step 1 builds the redirect URI from it). Not
   installed, or no owner: [gateway.md](gateway.md) first.
3. Note the scopes: the union of what every app that lists
   `google-workspace` names in its `everyapp.config.ts` (the list at the
   top of this file for the EveryApp apps; another app's is in its
   manifest, or `pnpm everyapp secret list <app id> --json`'s setting).
   They decide steps 3 and 5. Ask whether a Cloud project or a Web client
   exists for this already: then step 6 adds the redirect URI to it.
4. Ask whether every member who will connect is in one Google Workspace
   organization. Yes: *Internal*, no verification. No: *External* (step 7).
   A member on a gmail.com account is outside any organization: *External*.
   Wait for both answers before giving the steps: they decide step 2's
   Location, step 4's Audience and whether step 7 applies.

## Steps

Once the audience is known, steps 2 to 6 (and 7 for *External*) can go to
the person in one message, with step 1's URI; then wait for the file
before step 8.

1. **You:** the redirect URI is the Gateway's, the same for every app:
   `https://<gateway host>/connect/google-workspace/callback`. Give it to
   the person for step 6.
2. **Person:** signed in to Google with the Workspace account (a gmail.com
   account shows no organization), create the project at
   https://console.cloud.google.com/projectcreate: Project name (for example
   `EveryApp`), Location → Browse → the Workspace organization (needed for
   *Internal*; "No organization" otherwise) → Create. Done when the
   project's dashboard opens with its name in the top bar. With gcloud
   (checked against the reference, not run here): the person runs
   `gcloud auth login` (opens a browser), then
   `gcloud projects create every-app-gateway-<4 digits> --name="EveryApp" --set-as-default`
   (any unused id: ids are global and never reusable, so a taken one is
   refused; add `--organization=ORGANIZATION_ID` for *Internal*, the number
   from `gcloud organizations list`).
3. **Person:** enable the API behind each scope at
   `https://console.cloud.google.com/apis/enableflow;apiid=<service>` →
   Enable (or APIs & Services → Library → each API → Enable): Gmail
   scopes, `gmail.googleapis.com`; Calendar, `calendar-json.googleapis.com`;
   `webmasters.readonly`, `searchconsole.googleapis.com`;
   `analytics.readonly`, `analyticsadmin.googleapis.com` and
   `analyticsdata.googleapis.com`. Done when each shows "API Enabled".
   With gcloud: `gcloud services enable <service> …` with the same ids.
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
   filter each scope from step 3 of Before you start, tick it → Update →
   Save; never a scope no app lists. Only the scopes of enabled APIs are
   listed: a missing one means step 3, or paste its full URL
   (`https://www.googleapis.com/auth/<scope>`) under "Manually add
   scopes". Done when each is listed under "Your restricted scopes" or
   "Your sensitive scopes".
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
   In Testing every consent expires after 7 days: members reconnect in each
   app weekly. Publish app moves to In production: the unverified-app
   screen and a lifetime cap of 100 new users until verification (plus the
   CASA assessment for a restricted Gmail scope) passes. Verification
   (after Publish app: Prepare for Verification → Submit for Verification)
   needs a home page and a privacy policy on a domain the person owns,
   listed under Authorized domains and verified in Search Console by a
   project owner or editor, a demo video of the consent flow and a written
   scope justification; Google answers by email over several weeks. Until
   then stay in Testing (weekly reconnects, 100 test users); the run
   resumes at Verify when Google's mail comes. Skip for *Internal*.
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
   Each ends with a `done` event whose `data.gateway.names` holds the name.
   Then tell the person the file still holds the secret and ask them to
   delete it (or ask before running `rm` on it).
   Alternative, the person types it: in their own terminal,
   `pnpm everyapp configure <app>` (it asks for the client's two names, id
   then secret, with hidden prompts; for an app where the client is
   optional, Yes to `Set the N optional settings too?`) or
   `pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET`
   (two hidden prompts, just these), then they tell you.
9. **Person,** once the app opens (`data.app.setup.ready` true; while
   another required setting is unmet the Gateway opens the app's setup
   dialog instead, so finish those first): open the app, select its
   Connect Google button (OpenMail's mailbox setup, Open CRM's Settings →
   Connections, OpenSEO's project settings), choose the account (Testing:
   "Google hasn't verified this app" → Continue) → Allow. Done when the
   app shows the account connected. Each member does this in each app
   they use.

## Verify

1. `pnpm everyapp secret list <app id> --json`, from anywhere: the
   `google-workspace` setting has `set: true`; both names in
   `data.gateway.names`, their `data.gateway.needed` entries
   `"set": true`, and `data.gateway.missing` doesn't list them. Then
   `pnpm everyapp status --json`: the app's `setup.ready` is true and
   `data.fixes` has no `APP_NEEDS_SETUP` for it.
2. Smoke check, in the person's browser: the app's Connect Google button
   appears (the app read `integrationStatus()` with `configured: true` and
   `connection: null`).
3. App check: step 9. Google's account chooser means the client id and
   redirect URI match; the account shown as connected means the Gateway
   exchanged the code with the secret and Google granted no more than the
   app asked. `pnpm everyapp provider connections --all --json` lists the
   connection with its app and scopes.
4. Logs: the dashboard, README's path:
   **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**
   (the stored Workers Logs are on the same page); filter
   `capability: "google-workspace"`. Each API call is one
   `integration.proxy.call` line with the host, path and `status`, never a
   token or a body.

## If it fails

| Error or symptom | Meaning | What to do |
| --- | --- | --- |
| `SECRET_VALUE_REQUIRED` | Nothing was piped and there is no terminal | Use the pipe in step 8 or the person's terminal |
| `SECRET_SEVERAL_NAMES` | A pipe or `--from-env` with two names | One `secret set` per name |
| `SECRET_NOT_DECLARED` with `data.didYouMean` | Name typed wrong | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| `has("web")` prints `false`; `jq -r .web.client_id` prints `null` | A Desktop client's file (`installed` key); `null` must never be piped | Create a Web application client; unset anything set from it |
| App shows Google as not set up, no Connect button | `integrationStatus()` answers `configured: false`: the Gateway holds no client (or one name only) | Step 8; then reload |
| `integration_not_configured` (503) in the app's logs | A call while the Gateway holds no client | `secret list --json`; set both names |
| `capability_not_requested` (403) | The deployed manifest doesn't list `google-workspace` | Add `"google-workspace": { scopes: [...], why }` to everyapp.config.ts, deploy |
| `integration_not_connected` (409) | The person hasn't connected in this app, the connection expired, or the app now lists a scope the connection lacks (`missingScopes`) | The person connects (again) in the app at `connectPath` |
| After Allow, the Gateway's error page says Google granted scopes the app doesn't list | Google granted more than the app lists, so the token was refused and dropped | Remove the extra scopes from the consent screen if no app lists them, and connect again; nothing to revoke |
| The Gateway's error page: connect from inside the app | `/connect/google-workspace` was opened without `?app=` | Connect from the app's own button (`connectUrl()`) |
| Google "Error 400: redirect_uri_mismatch" | The URI on the client differs from step 1 | Fix it on the client; wait up to a few hours |
| Google "Error 401: invalid_client" | Client id or secret wrong, or secret disabled | Rotate (below) and set both again |
| Google "Error 403: access_denied" | The member is not a test user (Testing), or clicked Cancel | Add them in step 7, retry; or connect again |
| Google "Error 400: admin_policy_enforced" | The Workspace admin restricts the scopes or the app | A Workspace admin (Service Settings privilege): Admin console → Security → Access and data control → API controls (admin.google.com/ac/owl) → Manage App Access → Configure new app → search the client id → Continue → Trusted → Continue → Finish |
| Google "Error 403: org_internal" | *Internal* audience, account outside the organization | Use a Workspace account, or switch to *External* ([/docs/google-personal-accounts](https://everyapp.com/docs/google-personal-accounts)) |
| "Google hasn't verified this app" | *External*, unverified, sensitive or restricted scopes | Continue, or verify |
| Calls stop after 7 days, the app asks to reconnect | *External* in Testing: consent expired | Reconnect in the app; publish and verify to stop it |
| `403 accessNotConfigured` ("has not been used in project") from Google | The API behind a scope isn't enabled in that project | Step 3 in the project the error names; wait a minute |
| Google "Error 401: deleted_client" | The client was deleted (30-day restore window) | Restore it under Deleted credentials, or make a new one |

## Rerun, rotate, remove

- Rerun: every step is safe to repeat. `configure` and `secret set`
  replace; the console shows what exists. After an interruption start at
  Verify and continue at the first step that isn't done.
- A new scope: when an app adds a scope to its manifest, add it on the
  consent screen (step 5, step 3 for its API) before deploying the app;
  people with an older connection see Reconnect in that app.
- Rotate the secret, never the id: a new client id invalidates every
  connection's refresh token. Person: Clients → the client → Add secret
  (two at most; both work until one is disabled); the new secret is shown
  once, and they type it at the hidden prompt in their terminal
  (`pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_SECRET`). You verify
  with `secret list --json`; they test Connect; then they Disable the old
  secret, test again, and Delete it.
- Remove: `pnpm everyapp secret unset GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET --json`
  (add `--yes` only when the person said so); every app's Google calls stop.
  Then at Google: Clients → tick the client → Delete (restorable for 30
  days; Google also deletes clients unused for six months).

## Sources

- https://developers.google.com/workspace/guides/create-project (step 2)
- https://developers.google.com/workspace/guides/enable-apis (step 3)
- https://developers.google.com/workspace/guides/configure-oauth-consent (step 4)
- https://support.google.com/cloud/answer/15549135 (Data Access: only enabled APIs' scopes listed, Manually add scopes; step 5)
- https://support.google.com/cloud/answer/15549257 (clients: secret shown once, two at most, Add secret, 30-day restore, six-month inactivity; steps 6 and 8, Rotate, Remove)
- https://support.google.com/cloud/answer/15549945 (Audience: Internal needs an organization, External, Testing's 100 users and 7 days, Publish app; step 7)
- https://support.google.com/cloud/answer/13464321 (verification: home page, privacy policy, Search Console, demo video, scope justification; restricted scopes alone add the yearly assessment; step 7, Costs and plans)
- https://support.google.com/cloud/answer/9110914 (a scope's category is labeled in the console once added; step 5)
- https://developers.google.com/identity/protocols/oauth2/web-server (`access_type=offline`, `prompt`, `include_granted_scopes`, the response's `scope`; Settings)
- https://searchconsole.googleapis.com/$discovery/rest?version=v1, https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta, https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta (service names and the scopes each API takes; step 3)
- https://developers.google.com/webmaster-tools/limits and https://developers.google.com/analytics/devguides/reporting/data/v1/quotas (quotas; Costs and plans)
- `docs/design/2026-11-oauth-simplify.md` (per-app connections, the provider's own scopes, the mint check) and `docs/capabilities.md` "OAuth clients" (the generated table; Settings)
- https://support.google.com/accounts/answer/16668185 (Google's sign-in error codes; If it fails)
- https://docs.cloud.google.com/iap/docs/programmatic-oauth-clients (the API that created clients, shut down 2026-03-19; step 6)
- https://developers.google.com/health/app-verification (assessor fees; Costs and plans)
