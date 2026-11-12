---
title: "Slack for the Gateway"
description: "Step-by-step guide: one Slack app's OAuth client (SLACK_CLIENT_ID and _SECRET) on the Gateway, the scopes apps ask for, each member connecting their workspace."
---

One Slack app, registered once at api.slack.com, whose OAuth client the
Gateway holds. A member connects Slack once, from inside an app that lists
`slack`, for the bot scopes every app in the organization names in its
`everyapp.config.ts`. Each other app that lists `slack` then asks that
member to allow it, on the Gateway's own page. The
Gateway runs the flow on its own callback, keeps the bot token Slack issues
(the top-level token of `oauth.v2.access`; no user token) and puts it on
the app's calls to `slack.com`. No app sees a token or the client. Open CRM
uses it: an owner or admin connects the workspace in **Settings →
Connections**, and the CRM's team agents post to approved channels, manage
those channels and match members to Slack users by email. At the end the
person has a Slack app in their workspace whose redirect URL is the
Gateway's `https://<gateway host>/connect/slack/callback`, the Gateway holds
its Client ID and Client Secret, and connecting in the app completes.

## Settings

The client may be pasted in Manage workspace → Providers instead of set
below; a setting set here wins.

| Name                  | Required | What it holds                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `SLACK_CLIENT_ID`     | required | The app's **Client ID** (Basic Information → App Credentials), as shown. Public. |
| `SLACK_CLIENT_SECRET` | required | The app's **Client Secret** from the same section, as shown. The Gateway puts it on `oauth.v2.access` only. |

Set both: the Gateway offers Slack only when it holds the two. Both set
as Worker secrets while the Gateway had no `slack` row (an older CLI) are
read only once `secret set` binds them to the row: set them again, or
`secret unset` both to use a client pasted in Admin.

An app lists Slack's own bot scopes as written (no prefix), comma-joined on
the wire: `"slack": { scopes: ["channels:read", "chat:write"], why }`. A
connect asks for the scopes every app in the organization lists (Slack's
preset, `packages/sdk/src/internal/oauthPresets.ts`, adds none; the deploy
of an app that lists `slack` registers it as a row). The Gateway refuses a
bot token whose `scope` carries more, at connect and at every refresh.
Slack's scopes add up per workspace installation of one Slack app. Two
apps on this client are fine: the connect asks for both apps' scopes. An
installation that carries a scope no app in the organization lists is
refused (If it fails).

## Costs and plans

As of October 2026: creating a Slack app is free, no card. It needs a Slack
workspace the person may add apps to; Slack's free plan allows 10 app
installs per workspace, custom apps included. `apps.manifest.create` is Tier
1 (about one call a minute); `chat.postMessage` allows about one message a
second per channel. Slack's 2025 limit on `conversations.history` (1 request
a minute, 15 objects) applies to apps sold outside the Marketplace, not to
an internal app installed in its own workspace.

## Only a person can

- Sign in to Slack and pick the workspace. Anyone can create the app; a
  workspace that requires approved apps turns the install into a request a
  Workspace Owner (or an app manager they named) approves first. That
  approval is a wait: resume at Verify 3 once they say it is approved.
- Create the app in the browser, or generate the app configuration token
  that lets you create it.
- Copy the Client ID and Client Secret off Basic Information (path A).
- Click **Allow** on Slack's consent page when connecting, once, and on the
  Gateway's page in each other app that uses Slack.

## Before you start

1. `pnpm everyapp secret list <app id> --json` for each app that lists
   `slack` (from any directory; in the app's directory the id can be left
   off), before the Slack side. Read `data.app.setup.settings`, `unmet`
   and `command`. The client is one setting there, `id: "slack"`, `kind:
   "capability"`, `holder: "gateway"`, `names: ["SLACK_CLIENT_ID",
   "SLACK_CLIENT_SECRET"]` (the two names of one setting, set only when
   both are), `need.kind` as the app's manifest declares it (`optional`: in
   `settings` with `set: false`, never in `unmet`, and
   `pnpm everyapp configure <app>` offers it after the required ones;
   `required`: in `unmet`, the app closed until both are set), `setup:
   "setup/slack.md"` (this file). While its `set` is false this guide
   applies. With `set: true`: ask before replacing (a new app, or a
   regenerated secret). Not deployed yet: `APP_NOT_FOUND`; a bare
   `pnpm everyapp secret list --json` from the checkout still says whether
   the two names are in `data.gateway.names`. Note the scopes each app's
   `everyapp.config.ts` lists under `slack`: step 1 registers their union.
2. `pnpm everyapp status --json`: `data.installed` and `data.claimed` are
   true, and the Gateway's host: the redirect URL to register is
   `https://<gateway host>/connect/slack/callback`, the same for every app.
3. Ask: which workspace; whether a Slack app for this exists already at
   https://api.slack.com/apps (reuse it: step 2a's second paragraph); and
   whether they have `curl` and `jq` (path B).
4. Pick a path. **A**: they create the app from a manifest in the browser
   and type the client at a hidden prompt. **B**: they generate an app
   configuration token; `apps.manifest.create` returns the client, piped in.

## Steps

1. **You:** write the manifest to a file outside the repository, say
   `/tmp/slack-manifest.json`, with `<gateway host>` filled in and the bot
   scopes the union of what the apps list. Nothing in it is secret.

   ```json
   {
     "_metadata": { "major_version": 2, "minor_version": 1 },
     "display_information": {
       "name": "EveryApp",
       "description": "Your EveryApp apps post to Slack and read channels and members."
     },
     "features": { "bot_user": { "display_name": "everyapp", "always_online": false } },
     "oauth_config": {
       "redirect_urls": ["https://<gateway host>/connect/slack/callback"],
       "scopes": {
         "bot": ["channels:read", "chat:write"]
       }
     },
     "settings": { "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false }
   }
   ```

   Replace the `bot` list with the scopes every app that lists `slack`
   names in its `everyapp.config.ts` (Open CRM's entry lists the scopes to
   post, manage channels and match members by email, such as
   `users:read.email`, `chat:write.public` and `channels:manage`; read its
   manifest rather than guessing). No user scopes: the Gateway keeps the
   bot token only. The Gateway's authorize URL carries the union of the
   apps' lists as `scope`; the manifest's list is what the console's own
   Install button and a reinstall request, so keep it no wider than that
   union. Slack's limits: `name` 35 characters, `description` 140;
   `display_name` takes a-z, 0-9, `-`, `_` and `.` only. Step 3b validates
   the file first.

2a. **Person (path A):** open https://api.slack.com/apps, signed in to
   Slack: **Create New App** (https://api.slack.com/apps?new_app=1 opens
   that dialog) → **From an app manifest** (older dialogs: **From a
   manifest**) → pick the workspace → **Next** → the **JSON** tab, paste
   the file's content → **Next** (the review lists the name, the redirect
   URL and the scopes) → **Create**. It lands on **Basic Information**,
   whose **App Credentials** section shows **Client ID** and a hidden
   **Client Secret**; 3a uses both.
   Reusing an app: **OAuth & Permissions**, add the redirect URL under
   **Redirect URLs** and save; under **Scopes**, add the bot scopes to **Bot
   Token Scopes** (**Add an OAuth Scope**). Or, with path B's token, `apps.manifest.update` with
   `app_id=` and the same manifest; it returns no credentials.

3a. **Person (path A):** in a second terminal, in the `every-app` folder:
   `pnpm everyapp configure <app>` (it asks for the client's two names, id
   then secret, with hidden prompts, after the app's required settings;
   for an app where the client is optional, Yes to `Set the N optional
   settings too?`, Enter skipping the others) or
   `pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET`
   for just these two (the setup rules' first way; no `--json`, so it prompts).
   Paste the Client ID at the first prompt; click **Show** next to Client
   Secret and paste it at the second. Nothing is echoed. Give 2a and 3a in
   one message and wait once, until they say both values are in (a create
   that failed, they report instead). Go to Verify.

2b. **Person (path B):** open https://api.slack.com/apps; below the list of
   apps, under **Your App Configuration Tokens**, click **Generate Token**,
   pick the workspace, **Generate**; copy the **Access Token** (it starts
   `xoxe.xoxp-`, expires 12 hours later, and adds "Slack Tooling Tokens
   Vendor" to the workspace). In their terminal, in the `every-app` folder,
   read it in hidden (the setup rules' third way), never on a command line or in a
   typed `export …=`, which the shell history keeps: bash or zsh
   `read -rs SLACK_CONFIG_TOKEN && export SLACK_CONFIG_TOKEN`, fish
   `read -s -x SLACK_CONFIG_TOKEN`; they paste the token and press Enter;
   nothing is echoed. Wait until they say it is exported.

3b. **Person (path B)**, or **You** when they exported it before starting
   you: one line at a time. `printf` keeps the token out of the process
   list; `-d @-` reads it from stdin.

   ```sh
   printf 'token=%s' "$SLACK_CONFIG_TOKEN" | curl -s -d @- --data-urlencode manifest@/tmp/slack-manifest.json https://slack.com/api/apps.manifest.validate
   ```

   Expect `{"ok":true,"errors":[]}`; `invalid_manifest` names each problem
   in `errors[].pointer`. Then, once only (each run makes another app). The
   answer carries three secrets (`client_secret`, `signing_secret`,
   `verification_token`), so it goes to a file only you and `jq` read,
   created private first, and removed on the same line as the last pipe:

   ```sh
   install -m 600 /dev/null /tmp/slack-app.json
   printf 'token=%s' "$SLACK_CONFIG_TOKEN" | curl -s -d @- --data-urlencode manifest@/tmp/slack-manifest.json https://slack.com/api/apps.manifest.create > /tmp/slack-app.json
   jq -e '.ok' /tmp/slack-app.json && jq '.app_id' /tmp/slack-app.json
   jq -r '.credentials.client_secret // empty' /tmp/slack-app.json | pnpm everyapp secret set SLACK_CLIENT_SECRET --json
   jq -r '.credentials.client_id // empty' /tmp/slack-app.json | pnpm everyapp secret set SLACK_CLIENT_ID --json; rm -f /tmp/slack-app.json
   ```

   the setup rules' second way. `jq -e '.ok'` printing `false`: `jq '.error'`
   names why (step 1, or the name is taken); stop and
   `rm -f /tmp/slack-app.json`. `// empty` keeps a missing field from
   going in as the string `null`: the pipe is empty and `secret set` stops
   with `SECRET_VALUE_REQUIRED`. Never print the file, and remove it even
   when a step failed. Each `secret set` ends with a `done` event. Keep the
   `app_id` for Verify.

## Verify

1. `pnpm everyapp secret list <app id> --json`, from anywhere: the `slack`
   setting has `set: true`; both names in `data.gateway.names`,
   `"set": true` in `data.gateway.needed`, not in `data.gateway.missing`.
   Then `pnpm everyapp status --json`: the app's `setup.ready` is true and
   `data.fixes` has no `APP_NEEDS_SETUP` for it.
2. Smoke check, in the person's terminal while `SLACK_CONFIG_TOKEN` is
   exported (path B), after `export SLACK_APP_ID=<app_id>` (fish:
   `set -x SLACK_APP_ID <app_id>`; the id isn't secret):

   ```sh
   printf 'token=%s&app_id=%s' "$SLACK_CONFIG_TOKEN" "$SLACK_APP_ID" | curl -s -d @- https://slack.com/api/apps.manifest.export | jq '.manifest.oauth_config'
   ```

   Expected: `redirect_urls` holds exactly
   `https://<gateway host>/connect/slack/callback`, and `scopes.bot` the
   list from step 1. Then `unset SLACK_CONFIG_TOKEN SLACK_APP_ID` (fish:
   `set -e`). Path A: the same is on the app's **OAuth & Permissions** page.
3. The app, deployed and open: 1's `data.app.setup.ready` true (while
   another required setting is unmet the Gateway opens the app's setup
   dialog instead: finish those first). In the app (Open CRM: **Settings →
   Connections → Slack**, as an owner or admin), its Connect Slack button:
   Slack's page names the Slack app and the workspace and lists the
   permissions; **Allow**; the Gateway returns the browser to the app,
   which shows Slack connected. No Connect button: the app's
   `integrationStatus()` says `configured: false` (Verify 1 again).
   `pnpm everyapp provider connections --all --json` lists the connection
   with the apps allowed to use it and its scopes.
4. Logs, when a connect fails: Slack's refusal shows on the Gateway's
   error page; the Gateway's own log (**Workers & Pages** →
   `every-app-gateway` → **Observability** (**Logs** on older accounts) →
   **Live**) has one `integration.proxy.call` per API call afterwards:
   `capability`, host, path, method and `status`, never a token or a body.
   Slack answers `200` with `"ok": false` on many errors, so `status` says
   only whether the call went through; the app reads Slack's `error`.

## If it fails

| Error or symptom                                                               | Meaning                                                                                  | What to do                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The app shows Slack as not set up, no Connect button; or `integration_not_configured` (503) | The Gateway holds no client, or one of the two names | `secret set` both, then Verify 1 |
| `capability_not_requested` (403)                                               | The deployed manifest doesn't list `slack` | Add `"slack": { scopes: [...], why }` to its `everyapp.config.ts`, then `pnpm everyapp deploy --json` in its directory |
| `integration_not_connected` (409)                                              | The person the call is for hasn't connected Slack, hasn't allowed this app, the connection expired, or the app now lists a scope the connection lacks or the person hasn't allowed (`missingScopes`) | The person opens `connectPath` from the app: it leads to Slack, which asks for the new scopes, or to the Gateway's page that allows the app |
| After **Allow**, the Gateway's error page says Slack granted more than the apps here list | The workspace's installation of this Slack app carries a scope no app in the organization lists (one an app listed before, or one added in Slack's console), so the Gateway refused the token | List the scope in an app that uses it and deploy. Or make a new Slack app that has only the listed scopes (steps 1 to 3) and set its client |
| `invalid_scope` on Slack's page                                                | A scope an app lists doesn't exist, or is a user scope                                   | Fix the app's `scopes` (bot scopes only), deploy, connect again                                          |
| `access_denied`                                                                | The person clicked Cancel on Slack's page                                                | Connect again and **Allow**                                                                              |
| `SECRET_VALUE_REQUIRED`                                                        | Nothing was piped (path B: the field was missing, so `// empty` piped nothing) and there is no terminal to prompt at | `jq '.error' /tmp/slack-app.json`; or one of the setup rules' three ways (its `data.rerun` shows the `--from-env` form) |
| `SECRET_SEVERAL_NAMES`                                                         | A pipe or `--from-env` with two names                                                    | One name per call (the fix in `data.fix`)                                                                |
| `SECRET_NOT_DECLARED` with `data.didYouMean`                                   | The name differs from a known one in case or underscores only                            | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| Slack's page: "redirect_uri did not match any configured URIs", then `Passed URI: …` | The Gateway's callback isn't registered on the Slack app exactly                     | Register `https://<gateway host>/connect/slack/callback` (https only, no `#`) under OAuth & Permissions → Redirect URLs; Verify 2 |
| `invalid_client_id`                                                            | `SLACK_CLIENT_ID` is wrong, or another app's                                             | Set it again from Basic Information → App Credentials                                                    |
| `bad_client_secret`                                                            | `SLACK_CLIENT_SECRET` is wrong or was regenerated                                        | Set it again (Rotate, below)                                                                             |
| `invalid_code`                                                                 | The code was used already or is older than ten minutes; also when `SLACK_CLIENT_ID` is another app's (Slack checks the code before the client) | Connect again and **Allow**; a second failure: compare the Client ID on Basic Information |
| `invalid_team_for_non_distributed_app`                                         | Installing into a workspace other than the one the app was created in                    | Create the app in that workspace, or **Manage Distribution → Activate Public Distribution**             |
| `token_expired`, `invalid_auth`, `not_authed` from `apps.manifest.*`           | The configuration token is past 12 hours, wrong, or missing from the body                | Generate a new one (step 2b)                                                                             |
| `invalid_manifest` with `errors[]`                                             | The manifest breaks Slack's schema                                                       | Fix what each `pointer` names; validate again                                                            |

## Rerun, rotate, remove

- **Rerun.** `configure` and `secret set` replace. Never run `apps.manifest.create` twice
  for one app: update the existing one (step 2a's second paragraph, or
  `apps.manifest.update`). A duplicate it made: with `SLACK_CONFIG_TOKEN`
  and the duplicate's id exported, and only when the person said to delete
  it (it is permanent),
  `printf 'token=%s&app_id=%s' "$SLACK_CONFIG_TOKEN" "$SLACK_APP_ID" | curl -s -d @- https://slack.com/api/apps.manifest.delete`
  (expect `{"ok":true}`). Path A, or a token past 12 hours: its **Basic
  Information** page.
- **Rotate.** Basic Information → App Credentials → **Regenerate** next to
  **Client Secret** (Slack's FAQ still says **Change secret**). The old
  secret works for 24 hours unless revoked manually. The person sets
  `SLACK_CLIENT_SECRET` again at the hidden prompt (step 3a); no API
  returns the new secret.
- **Remove.** People disconnect under Your connections → Accounts, which
  stops every app at once
  (owners and admins: `pnpm everyapp provider disconnect slack --all`).
  Then `pnpm everyapp secret unset SLACK_CLIENT_ID SLACK_CLIENT_SECRET --json --yes`
  (`--yes` only when the person said so). Then delete the app: the
  `apps.manifest.delete` line above (path B, token still valid, person
  said so) or https://api.slack.com/apps → the app → Basic Information; or
  at least regenerate its secret: a client the Gateway no longer holds is
  still a client.

## Sources

- https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests (manifest flow; configuration tokens)
- https://docs.slack.dev/reference/app-manifest (fields and limits)
- https://docs.slack.dev/reference/methods/apps.manifest.create, …/apps.manifest.validate, …/apps.manifest.export, …/apps.manifest.delete (permanent; `token` and `app_id`)
- https://docs.slack.dev/tools/bolt-python/tutorial/custom-steps-workflow-builder-new/ (the create-from-manifest clicks: Create New App, From an app manifest, Next, JSON, Create)
- https://docs.slack.dev/authentication/installing-with-oauth/ (authorize parameters, redirect rules: https, no `#`, a subdirectory matches; `invalid_scope`, `unapproved_scope`, `bad_redirect_uri`; the code expires after ten minutes)
- https://docs.slack.dev/legacy/legacy-authentication/ (`error=access_denied` on Cancel; codes exchanged once, expire 10 minutes)
- https://docs.slack.dev/reference/methods/oauth.v2.access/ (token-call errors)
- https://docs.slack.dev/distribution/ (own workspace only until **Activate Public Distribution**)
- https://slack.com/help/articles/1500009181142 (no setting stops members creating internal apps) and https://slack.com/help/articles/222386767 (app approval: Workspace Owners and app managers approve requests)
- https://docs.slack.dev/authentication/verifying-requests-from-slack/ (**Regenerate**; the old secret valid 24 hours unless revoked) and https://docs.slack.dev/faq/ (**Change secret**)
- https://docs.slack.dev/apis/web-api/rate-limits and https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- https://slack.com/help/articles/27204752526611 (free plan: 10 app installs)
- https://community.n8n.io/t/slack-oauth-redirect-uri-did-not-match-any-configured-uris-self-hosted-on-windows/271936 (the redirect error's wording, with its `Passed URI:` line)
- https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ (Workers & Pages → Overview → the Worker → Logs → Live)
- https://api.slack.com/apps (the console; `?new_app=1` opens the create dialog)
- Local: `packages/sdk/src/internal/oauthPresets.ts` (the `slack` spec: comma-separated, no prefix, PKCE off, the bot token only), `docs/design/2026-11-oauth-one-connection.md` (one connection per person, the apps allowed to use it), `docs/design/2026-11-oauth-simplify.md` (the provider's own scopes, the mint check) and docs/capabilities.md ("OAuth clients")
