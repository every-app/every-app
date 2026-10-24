# Slack for the Gateway

One Slack app, registered once at api.slack.com, whose OAuth client the
Gateway holds. Open CRM uses it: an owner or admin connects their workspace
from **Settings → Connections**, and the CRM's team agents post to approved
channels, manage those channels and match members to Slack users by email.
At the end the person has a Slack app in their workspace, the Gateway holds
its Client ID and Client Secret, and **Connect Slack** in Open CRM completes.

## Settings

| Name                  | Required | What it holds                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `SLACK_CLIENT_ID`     | required | The app's **Client ID** (Basic Information → App Credentials), as shown. Public; apps get it for the authorize URL. |
| `SLACK_CLIENT_SECRET` | required | The app's **Client Secret** from the same section, as shown. The Gateway puts it on `oauth.v2.access` only. |

Set both: the Gateway offers Slack only when it holds the two.

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
- Click **Allow** on Slack's consent page when connecting Open CRM.

## Before you start

1. `pnpm everyapp secret list crm --json`, from any directory (the id reads
   the manifest Open CRM's last deploy stored; in its directory the id can
   be left off), before the Slack side, not at Verify. The rule: read
   `data.app.setup.settings`, `unmet` and `command`. The client is one
   setting there, `id: "slack"`, `kind: "capability"`, `holder:
   "gateway"`, `names: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]` (an
   OAuth client's id and secret are the two names of one setting, set
   only when both are), `need.kind` as the CRM's manifest declares it
   (Open CRM: `optional`: it sits in `settings` with `set: false`, never
   in `unmet`, the CRM opens without Slack and `command`,
   `pnpm everyapp configure crm`, offers it after the required ones;
   `required` would put it in `unmet`, close the CRM and have configure
   ask for both names first), `setup: "setup/slack.md"` (this file). While
   its `set` is false this file applies.
   The same entry in `data.app.setup.settings` with `set: true`: ask
   before replacing (a new app, or a regenerated secret). Not deployed
   yet: `secret list crm` stops with `APP_NOT_FOUND`; a bare
   `pnpm everyapp secret list --json` from the checkout still says whether
   the two names are in `data.gateway.names` (ask before replacing), and
   the rest of this item waits for the first deploy.
2. `pnpm everyapp status --json`: `data.installed` and `data.claimed` are
   true; `data.appBaseDomain` is `<app base domain>` (the redirect URL to
   register is `https://<app>.<app base domain>/integrations/slack/callback`,
   deployed as `crm`: `https://crm.<app base domain>/integrations/slack/callback`);
   Open CRM's entry in `data.apps[]` (its `id`, `crm` below) has
   `"status": "active"`, `"bound": true`, the `workerName` Verify 4 needs
   and, as `setup`, 1's `data.app.setup` again: what else the CRM needs.
   Not deployed yet: the URL is the same, so the Slack side can go first;
   Verify 3 needs the CRM deployed.
3. In 1's answer, `data.app.workers[].names` must hold
   `TOKEN_ENCRYPTION_KEY`, the CRM's own secret its Slack connect needs (it
   stores the tokens encrypted under it; optional in the manifest, so its
   entry sits in `settings` with `holder: "app"`, never in `unmet`).
   Unset: set it first, after the CRM's first deploy, at the hidden prompt
   of `pnpm everyapp configure crm` (which offers it with the optional
   ones) or `pnpm everyapp secret set TOKEN_ENCRYPTION_KEY --app crm`, from
   anywhere, 32 or more random characters, never through the chat; without
   it **Connect Slack** stops
   before Slack opens (the table). Not deployed yet: set it right after its
   first deploy, before Verify 3.
4. Ask: which workspace; whether a Slack app for this exists already at
   https://api.slack.com/apps (reuse it: step 2a's second paragraph); and
   whether they have `curl` and `jq` (path B).
5. Pick a path. **A**: they create the app from a manifest in the browser
   and type the client at a hidden prompt. **B**: they generate an app
   configuration token; `apps.manifest.create` returns the client, piped in.

## Steps

1. **You:** write the manifest to a file outside the repository, say
   `/tmp/slack-manifest.json`, with `<app>` (Open CRM's `id`) and
   `<app base domain>` filled in. Nothing in it is secret.

   ```json
   {
     "_metadata": { "major_version": 2, "minor_version": 1 },
     "display_information": {
       "name": "Open CRM",
       "description": "Team agents post to your Slack channels from Open CRM."
     },
     "features": { "bot_user": { "display_name": "open-crm", "always_online": false } },
     "oauth_config": {
       "redirect_urls": ["https://<app>.<app base domain>/integrations/slack/callback"],
       "scopes": {
         "bot": ["users:read", "users:read.email", "channels:read", "groups:read", "chat:write", "chat:write.public", "im:write", "channels:join", "channels:manage", "groups:write", "channels:write.invites", "groups:write.invites"],
         "user": ["channels:read", "channels:write", "groups:read", "groups:write"]
       }
     },
     "settings": { "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false }
   }
   ```

   Use these lists as written: they are Open CRM's own (its
   `src/shared/slack.ts`, which matters only when a newer CRM changes them;
   a CRM directory with no `src/` has nothing to compare, and needs none):
   bot scopes to post, manage channels and match members by email; user
   scopes so the installer can invite the bot to private channels. Its
   authorize URL carries them as `scope` (bot) and `user_scope` (user), and
   that URL decides what Slack asks the installer for: Slack's docs name
   only `invalid_scope` (a scope that doesn't exist, or conflicting ones)
   and `unapproved_scope` (a published Marketplace app requesting scopes
   its review didn't cover) on the authorize URL. The manifest's lists are
   what the console's own Install button and a reinstall request. The
   registry (`packages/sdk/src/internal/capabilities.ts`, the `slack`
   entry's `scopePolicy`, #425) groups them into sets an app lists in its
   manifest entry (`everyapp deploy` refuses `slack` without `scopes`):
   bot sets `channels.read`, `users.read`, `users.email`,
   `messages.write`, `channels.join`, `channels.manage`, `files.write`,
   user set `user-channels.manage` (the table in docs/capabilities.md,
   "OAuth clients"). Open CRM lists all but `files.write`; the lists
   above are the provider scopes behind its sets, less
   `chat:write.customize` (in `messages.write`; the CRM doesn't ask for
   it). The Gateway holds the CRM to its sets at `oauth.v2.access` (#411):
   an entry without `scopes` is refused (`integration_scopes_undeclared`),
   an installation carrying a scope outside them too
   (`integration_scope_exceeded`: reinstall from the CRM); a CRM deployed
   before its manifest carried `scopes` must redeploy before the Gateway
   is updated from main (TODO.md "OAuth scopes (2026-10-24)", follow-up 0).
   Slack's limits: `name` 35 characters, `description` 140; `display_name`
   takes a-z, 0-9, `-`, `_` and `.` only. Step 3b validates the file first.

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
   Token Scopes** (**Add an OAuth Scope**) and the user scopes to **User
   Token Scopes**. Or, with path B's token, `apps.manifest.update` with
   `app_id=` and the same manifest; it returns no credentials.

3a. **Person (path A):** in a second terminal, in the `every-app` folder:
   `pnpm everyapp configure crm` (it asks for the client's two names, id
   then secret, with hidden prompts, after the CRM's required settings;
   the client is optional for Open CRM, so Yes to `Set the N optional
   settings too?`, Enter skipping the others; with one of the two
   names set it asks only for the other; or pick
   `SLACK_CLIENT_ID + SLACK_CLIENT_SECRET` from the menu once the CRM is
   ready) or `pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET`
   for just these two (README's first way; no `--json`, so it prompts).
   Paste the Client ID at the first prompt; click **Show** next to Client
   Secret and paste it at the second. Nothing is echoed. Give 2a and 3a in
   one message and wait once, until they say both values are in (a create
   that failed, they report instead). Go to Verify.

2b. **Person (path B):** open https://api.slack.com/apps; below the list of
   apps, under **Your App Configuration Tokens**, click **Generate Token**,
   pick the workspace, **Generate**; copy the **Access Token** (it starts
   `xoxe.xoxp-`, expires 12 hours later, and adds "Slack Tooling Tokens
   Vendor" to the workspace). In their terminal, in the `every-app` folder,
   read it in hidden (README's third way), never on a command line or in a
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

   README's second way. `jq -e '.ok'` printing `false`: `jq '.error'`
   names why (step 1, or the name is taken); stop and
   `rm -f /tmp/slack-app.json`. `// empty` keeps a missing field from
   going in as the string `null`: the pipe is empty and `secret set` stops
   with `SECRET_VALUE_REQUIRED`. Never print the file, and remove it even
   when a step failed. Each `secret set` ends with a `done` event. Keep the
   `app_id` for Verify.

## Verify

1. `pnpm everyapp secret list crm --json`, from anywhere: the `slack`
   setting has `set: true` (optional for Open CRM, so it was never in
   `data.app.setup.unmet`; a manifest that requires it has it leave
   `unmet`, with `ready: true` and `command` null once nothing else is
   missing); both names in `data.gateway.names`, `"set": true` in
   `data.gateway.needed`, not in `data.gateway.missing`. Then
   `pnpm everyapp status --json`: the `crm` entry's `setup.ready` is true
   and `data.fixes` has no `APP_NEEDS_SETUP` for it (the Gateway opens the
   CRM again).
2. Smoke check, in the person's terminal while `SLACK_CONFIG_TOKEN` is
   exported (path B), after `export SLACK_APP_ID=<app_id>` (fish:
   `set -x SLACK_APP_ID <app_id>`; the id isn't secret):

   ```sh
   printf 'token=%s&app_id=%s' "$SLACK_CONFIG_TOKEN" "$SLACK_APP_ID" | curl -s -d @- https://slack.com/api/apps.manifest.export | jq '.manifest.oauth_config'
   ```

   Expected: `redirect_urls` holds exactly
   `https://<app>.<app base domain>/integrations/slack/callback`, and
   `scopes.bot` and `scopes.user` the lists in step 1. Then
   `unset SLACK_CONFIG_TOKEN SLACK_APP_ID` (fish: `set -e`). Path A: the
   same is on the app's **OAuth & Permissions** page.
3. The app, deployed and open: 1's `data.app.setup.ready` true. While
   another required setting of the CRM is unmet, the Gateway sends a
   browser to its setup dialog instead of the CRM (anything else gets 503
   `app_needs_setup`): finish those first (each `unmet` entry's `setup`
   names its file); until then 1 is the check of the Slack client. Then
   at `https://<app>.<app base domain>`, **Settings →
   Connections → Slack** (an owner or admin). With the client on the
   Gateway the card has **Connect Slack**; without it the section reads
   **Slack is not configured** and, for an owner or admin, shows the
   redirect URL and `pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET`
   (Verify 1 again; the same when the deployed CRM doesn't list `slack`,
   or lists it without `scopes`).
   **Connect Slack**: Slack's page names the app and the workspace and
   lists the permissions; **Allow**; the CRM comes back connected and shows
   the workspace. Otherwise its page says why, `?error=` naming one of
   seven: `access_denied` (Cancel was clicked), `invalid_state` (the
   approval is older than ten minutes, was used already, or was started by
   someone else: start again), `forbidden` (not an owner or admin),
   `rejected` (Slack sent another error, or no code: try again),
   `exchange_failed` (the token call returned no token: Verify 4, then the
   table), `failed` (the CRM couldn't store the tokens: its log has
   `[slack] connect failed`), `not_configured` (local dev only: the CRM
   has no Gateway binding).
4. Logs. Slack's error code is in Open CRM's Worker, not the Gateway's: the
   Cloudflare dashboard, README's path with the CRM's Worker in place of
   the Gateway's: **Workers & Pages** → the `crm` entry's `workerName` →
   **Observability** (**Logs** on older accounts) → **Live** (Workers Logs keeps them; `cf workers` has
   no tail, and `cf o11y telemetry query` needs a query body). On
   `exchange_failed` the line `[slack] connect refused` carries `status`
   and `reason`: Slack's code (`invalid_code`, `bad_redirect_uri`,
   `invalid_client_id`, `bad_client_secret`: the table), or a Gateway
   refusal that reached the callback (`status` 503, reason
   `Service Unavailable`: `integration_not_configured`; 403, `Forbidden`:
   `capability_not_requested`, `integration_scopes_undeclared` (the
   deployed CRM lists `slack` without `scopes`) or
   `integration_scope_exceeded` (the installation carries a scope outside
   the CRM's sets: reinstall from the CRM)). The Gateway's own log (`every-app-gateway`,
   same path) has one `integration.proxy.call` per token call:
   `capability`, host, path, method, `grantType` (the request's
   `grant_type`) and `status`; never the body, and Slack answers `200` with
   `"ok": false` on a bad client, so it says only whether the call went
   through.

## If it fails

| Error or symptom                                                               | Meaning                                                                                  | What to do                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SECRET_VALUE_REQUIRED`                                                        | Nothing was piped (path B: the field was missing, so `// empty` piped nothing) and there is no terminal to prompt at | `jq '.error' /tmp/slack-app.json`; or one of README's three ways (its `data.rerun` shows the `--from-env` form) |
| `SECRET_VALUE_REQUIRED` from `pnpm everyapp configure crm --json`             | Nothing was piped (with `--from-env`, stdin isn't read), no variable of a missing name was found, and there is no terminal; the message names what the CRM still needs (this client is optional for Open CRM, so never among them) | The pipes in 3b, or the person's terminal (3a)                                              |
| `SECRET_SEVERAL_NAMES`                                                         | A pipe or `--from-env` with two names                                                    | One name per call (the fix in `data.fix`)                                                                |
| `SECRET_NOT_DECLARED` with `data.didYouMean`                                   | The name differs from a known one in case or underscores only                            | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| `SECRET_NOT_DECLARED` without it                                               | A misspelt name; in Open CRM's directory its `data.fix` offers to add it to the CRM's own `secrets` | Retype the name from Settings above; never add a `SLACK_*` name to Open CRM's `secrets`            |
| CRM: **Slack is not configured**, the `secret set` command, no **Connect Slack** | The Gateway holds no client, or one of the two names (a call would get `integration_not_configured`); or the deployed CRM doesn't list `slack` with `access: "write"` and `scopes` (`capability_not_requested`; without `scopes`, `integration_scopes_undeclared`) | `secret set` both, then Verify 1; or its `everyapp.config.ts` (`slack: { access: "write", scopes: [...], why }`), then `pnpm everyapp deploy --json` in its directory |
| CRM: `exchange_failed`; its log `[slack] connect refused` with `status` 503 or 403 | The Gateway refused between **Connect Slack** and the callback: the client was unset, or the manifest changed, meanwhile | The row above, then connect again                                                              |
| CRM: **Connect Slack** fails before Slack opens: "Connections aren't set up on this CRM yet" | The CRM's own `TOKEN_ENCRYPTION_KEY` is unset, or under 32 characters                 | Set it after the CRM's first deploy: `pnpm everyapp configure crm` (which asks for it) or `pnpm everyapp secret set TOKEN_ENCRYPTION_KEY --app crm` from anywhere (in the CRM's directory the flag can be left off), the value in one of README's three ways (Before you start 3); connect again |
| Slack's page: "redirect_uri did not match any configured URIs", then `Passed URI: …` | The URI the CRM sent isn't registered on the app exactly, or under a registered URL  | Register the Passed URI, `https://<app>.<app base domain>/integrations/slack/callback` (https only, no `#`), under OAuth & Permissions → Redirect URLs; Verify 2 |
| `bad_redirect_uri` (token call)                                                | `redirect_uri` differed between the authorize and token calls                            | The CRM sends its own host; check the app runs on `https://<app>.<app base domain>`                     |
| `invalid_scope`                                                                | A scope name doesn't exist, or bot and user scopes are mixed up                          | Compare with step 1; bot scopes go in `scope`, user scopes in `user_scope`                               |
| `invalid_client_id`                                                            | `SLACK_CLIENT_ID` is wrong, or another app's                                             | Set it again from Basic Information → App Credentials                                                    |
| `bad_client_secret`                                                            | `SLACK_CLIENT_SECRET` is wrong or was regenerated                                        | Set it again (Rotate, below)                                                                             |
| `invalid_code`                                                                 | The code was used already or is older than ten minutes; also when `SLACK_CLIENT_ID` is another app's (Slack checks the code before the client) | Connect again and **Allow**; a second failure: compare the Client ID on Basic Information |
| CRM: `access_denied`                                                           | The person clicked Cancel on Slack's page                                                | Connect again and **Allow**                                                                              |
| `invalid_team_for_non_distributed_app`                                         | Installing into a workspace other than the one the app was created in                    | Create the app in that workspace, or **Manage Distribution → Activate Public Distribution**             |
| `token_expired`, `invalid_auth`, `not_authed` from `apps.manifest.*`           | The configuration token is past 12 hours, wrong, or missing from the body                | Generate a new one (step 2b)                                                                             |
| `invalid_manifest` with `errors[]`                                             | The manifest breaks Slack's schema                                                       | Fix what each `pointer` names; validate again                                                            |
| CRM: "Slack refused: a permission is missing. Reconnect Slack."                | The workspace's install predates a scope                                                 | Disconnect and connect again, so Slack asks for the new scopes                                           |

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
- **Remove.** In Open CRM, **Settings → Connections → Disconnect Slack**.
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
- https://docs.slack.dev/reference/scopes/channels.write (User only) and …/channels.manage (Bot only)
- https://docs.slack.dev/distribution/ (own workspace only until **Activate Public Distribution**)
- https://slack.com/help/articles/1500009181142 (no setting stops members creating internal apps) and https://slack.com/help/articles/222386767 (app approval: Workspace Owners and app managers approve requests)
- https://docs.slack.dev/authentication/verifying-requests-from-slack/ (**Regenerate**; the old secret valid 24 hours unless revoked) and https://docs.slack.dev/faq/ (**Change secret**)
- https://docs.slack.dev/apis/web-api/rate-limits and https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- https://slack.com/help/articles/27204752526611 (free plan: 10 app installs)
- https://community.n8n.io/t/slack-oauth-redirect-uri-did-not-match-any-configured-uris-self-hosted-on-windows/271936 (the redirect error's wording, with its `Passed URI:` line)
- https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ (Workers & Pages → Overview → the Worker → Logs → Live)
- https://api.slack.com/apps (the console; `?new_app=1` opens the create dialog)
- Local, 2026-10-24: `packages/sdk/src/internal/capabilities.ts` (the `slack` entry: its `scopePolicy`, seven bot sets and one user set, #425), docs/capabilities.md ("OAuth clients": the scope sets table), TODO.md ("OAuth scopes (2026-10-24)", the Slack bullet)
