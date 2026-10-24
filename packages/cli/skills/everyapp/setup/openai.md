# OpenAI for the Gateway

One `OPENAI_API_KEY` on the Gateway lets every app whose `everyapp.config.ts`
lists `providers: ["openai"]` call OpenAI's inference endpoints through the
Gateway, which puts the key on each call; no app holds it. The launch apps
OpenSEO and agentic-inbox don't list it (OpenRouter and Workers AI do their
AI); an app that lists `providers: ["openai"]` in its manifest does. Set it up when
`pnpm everyapp secret list <app id> --json` lists `OPENAI_API_KEY` in
`data.app.setup.unmet`, or `status` says the app needs setup and names this
file. At the end the person has an
OpenAI organization with a card and prepaid credits, one project API key
the Gateway holds, and a call that answers.

## Settings

| Name                    | Required or optional                                                  | What it holds                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`        | required by any app listing the `openai` provider                     | one OpenAI project API key, exactly as shown once at creation (starts with `sk-`); the Gateway sends it as `Authorization: Bearer` to `api.openai.com` only                                                                                                                                                                                                |
| `AI_PROXY_EXTRA_ROUTES` | optional; required when the app's manifest has `ai.routes`            | OpenAI paths beyond inference the Gateway may forward: comma or space separated, each starting with `/v1/` and made of lowercase letters, digits, `_` and `-` (`/v1/files`, or `/v1/files,/v1/batches`); each covers its sub-paths; an entry in any other shape is dropped silently; one list for every app on the Gateway, replaced whole by each `secret set`; not a secret |

Inference needs no extra route: POST to `/v1/responses`,
`/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/speech`,
`/v1/audio/transcriptions`, `/v1/audio/translations`,
`/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations`. On
`/v1/responses` and `/v1/chat/completions` the Gateway sets `store: false`:
OpenAI keeps no copy of the response for later retrieval, so an app can't
chain `previous_response_id` through it; OpenAI's usual API retention
(abuse-monitoring logs, up to 30 days, unless the organization is approved
for Zero Data Retention) still applies. Any other path goes through only
when both `AI_PROXY_EXTRA_ROUTES` and the app's `ai.routes` cover it: one
key serves every app in every organization, and OpenAI keeps files, batches
and fine-tunes per account.

## Costs and plans

As of October 2026 the API is prepaid. Billing needs a card; the first
purchase is $5 at least ($10 by default), auto-reload is on by default
during setup, credits expire after one year and are not refunded. New
accounts get no sign-up credits (unverified: third-party reports; OpenAI's
own pages don't say). Usage tiers rise with total credit purchases: Free
($100 a month ceiling, allowed geographies only), Build ($5 bought, $500 a
month), Launch ($100, $5,000 a month), Grow ($500, $200,000 a month); each
tier sets requests and tokens per minute per model, reported in
`x-ratelimit-*` response headers. A ChatGPT subscription is separate and
gives no API credit.

## Only a person can

- Sign up or sign in at platform.openai.com and accept OpenAI's terms.
- Add a card and buy credits.
- Verify a phone number when the account creates its first key.
- Create the project API key and copy it off the screen; it is shown once.
- Set a spend limit on the organization or project, if they want one.
- Complete API Organization Verification (a government ID upload) when a
  model the app uses asks for it.

## Before you start

1. `pnpm everyapp secret list <app id> --json`, from any directory (the app
   id is `data.apps[].id` in `status`, 2, or the `id` in the app's
   `everyapp.config.ts`; in the app's directory `pnpm everyapp secret list
   --json` reads that file instead of the registry and works before the
   first deploy too): the `OPENAI_API_KEY` entry in `data.app.setup.unmet`
   (`names` `["OPENAI_API_KEY"]`, `need.kind` `required`, `holder`
   `gateway`, `setup` `setup/openai.md`; a manifest with `ai.routes` adds
   an entry `"id": "ai-routes"` with `names` `["AI_PROXY_EXTRA_ROUTES"]` and
   the same `setup`) means this file applies, and the app doesn't open until
   it is set: the Gateway lists it as needing setup, sends a browser opening
   `https://<app>.<app base domain>` to its setup dialog and answers
   anything else 503 `app_needs_setup`. `data.app.setup.command` is the one
   `pnpm everyapp secret set …` naming every missing Gateway setting
   (`data.next` repeats it). No `OPENAI_API_KEY` entry in
   `data.app.setup.settings`: the manifest's `providers` doesn't list
   `openai`; nothing to do. The entry with `"set": true`: ask before
   replacing it; the old value can't be read back, so replacing means a new
   key. A manifest that writes the provider as `{ id: "openai", optional:
   true }` puts it in `settings` with `need.kind` `optional` and never in
   `unmet`: the app opens without it, and this file still applies while
   `set` is false. The older fields still say the same:
   `data.gateway.needed` has `{"name":"OPENAI_API_KEY","required":true,"set":false}`
   (and `AI_PROXY_EXTRA_ROUTES` when the manifest has `ai.routes`), and
   `data.gateway.missing` lists what is still to set. This is how an agent
   lands here: `status` prints `Guide:
   .claude/skills/everyapp/setup/openai.md` under "<app> needs setup", and
   `secret list --json` carries the path as the entry's `setup` (in the
   checkout: `packages/cli/skills/everyapp/setup/openai.md`).
2. `pnpm everyapp status --json`: `data.installed` and `data.claimed` are
   true, `data.gatewayUrl` is `https://<gateway host>`; the app's entry in
   `data.apps` carries the same `setup`, and while a required setting is
   missing `data.fixes` has `APP_NEEDS_SETUP` for it (severity `warning`,
   headline "<app> needs setup", `run` the same command). Not installed, or
   no owner: [gateway.md](gateway.md) first.
3. Same output as 1, `data.app.deployed`: false means the app isn't deployed
   yet (from anywhere, an app that was never deployed ends `secret list
   <app id>` with the error `APP_NOT_FOUND`, "<app> isn't deployed to this
   Gateway yet", instead; the directory form shows `deployed: false`). A
   Gateway setting is set anyway, from any directory; deploy the app after,
   or before, as the person likes.
4. The question step 1 asks: do they already have an OpenAI API account
   with credits, and a project key they want to use? A key that was ever
   pasted in a chat or a ticket has been seen: make a new one.

## Steps

One Person step per message: give the step, wait for the words it ends
with ("signed in", "credits bought", the project's name, "done"), then the
next. Not a checklist to send at once; only steps 5 and 6 go together, so
the key goes from the clipboard to the hidden prompt with nothing to wait
for in between. Where to begin is step 1's answer: no account, step 2; an
account without credits, step 3; account and credits, step 5; step 4 only
when they want a project of their own.

1. **You:** Tell the person what Before you start found (set, missing,
   deployed or not), say in one line what the key is for (the Gateway adds
   it to every OpenAI call the app makes; the app never holds it), ask the
   question in Before you start 4, and stop. Nothing from the steps below
   until they answer.
2. **Person:** Sign in or sign up. Open https://platform.openai.com; signed
   out, it offers "Sign up or login with an OpenAI account". Continue with
   an email, Google, Microsoft or Apple account and confirm the email. The
   first sign-in creates an organization with a "Default project". It
   worked when the dashboard at https://platform.openai.com opens. Wait for
   "signed in".
3. **Person:** Add billing. Open
   https://platform.openai.com/settings/organization/billing/overview (in
   the dashboard: Settings, Organization, Billing). Click "Add payment
   details", pick Individual or Company, enter the card, then the initial
   credit amount (minimum $5, default $10). Auto-reload (a balance
   threshold, the balance to restore to, an optional monthly limit) is on
   by default on that screen; turn it off unless they want it. Credits
   belong to the organization, not to a project. It worked when the
   billing overview shows a credit balance; a new balance can take a few
   minutes to appear. Wait for "credits bought".
4. **Person:** A project, optional. The Default project is fine for one
   Gateway. For a separate one: on https://platform.openai.com, the project
   selector (top left), "Create project", a name (description and website
   optional), "Create"; only organization owners can. The projects list is
   at https://platform.openai.com/projects (owners only). Wait for the
   project's name.
5. **Person:** Create the key. In several organizations, pick the one with
   the credits top left first. Open https://platform.openai.com/api-keys.
   Click "+ Create new secret key". In the dialog: Owned by "You"; Name
   such as `every-app gateway`; Project: any project of that organization
   (the Default project is fine); Permissions "All"; Expiration: leave it
   unset, or set a date and note it where they'll see it, since the key
   stops working that day (Rotate, below). The account's first key asks
   for a phone number (a code by SMS or WhatsApp; no VoIP, landline or
   Google Voice numbers; a number serves at most three OpenAI accounts,
   deleted ones counted). Click "Create secret key", then "Copy". The key
   is shown once; after the dialog closes it can't be viewed again. Not in
   the chat: straight on to step 6, with the dialog still open.
   Aside: "Restricted" works with "Model Capabilities: Request" (add
   "Responses API: Write" when the app posts to `/v1/responses`) and "List
   Models: Read" for the smoke check; "Read Only" cannot run inference. A
   service account's key works only in a project from step 4 (none can be
   added to the Default project) and gets full project permissions, with
   no Permissions choice at creation.
6. **Person:** Set it, the README's first way (the value is on a dashboard
   they are looking at). In a second terminal, in the `every-app` folder:
   `pnpm everyapp secret set OPENAI_API_KEY`, paste at the hidden prompt
   (nothing is echoed). It prints "Live now on <gateway host>. No deploy
   needed." Wait for "done".
   Alternative, the README's third way, when the person exported
   `OPENAI_API_KEY` before starting you: **You:**
   `pnpm everyapp secret set OPENAI_API_KEY --from-env OPENAI_API_KEY --json`;
   the `done` event's `data.gateway.names` holds `OPENAI_API_KEY`.
7. **You:** Only when a manifest has `ai.routes`. The value is one list for
   every app on the Gateway, and `secret set` replaces it whole, so a list
   set for one app drops another's: `pnpm everyapp status --json` lists
   the apps (`data.apps[].id`), and each app with `ai.routes` has, in its
   `setup.settings`, an entry `"id": "ai-routes"` whose `why` names them
   ("Lets the app call /v1/files, /v1/batches through the AI proxy."); no
   checkout needed (one with an `everyapp.config.ts` at hand says the same
   under `ai.routes`). Pipe the union, comma separated, every time. It
   isn't a secret, so echo is fine:
   `echo "/v1/files,/v1/batches" | pnpm everyapp secret set AI_PROXY_EXTRA_ROUTES --json`;
   the `done` event's `data.gateway.names` holds `AI_PROXY_EXTRA_ROUTES`.
   One name per pipe. It can't be read back: tell the person what it holds.
8. **You:** Verify, below.

## Verify

1. `pnpm everyapp secret list <app id> --json`, from anywhere: the
   `OPENAI_API_KEY` entry in `data.app.setup.settings` has `"set": true`
   and has left `data.app.setup.unmet` (the `ai-routes` entry too, after
   step 7); `data.app.setup.ready` is true once nothing else of the app's
   is missing, and `data.app.setup.command` is null then. In the older
   fields, `OPENAI_API_KEY` is in `data.gateway.names`, its
   `data.gateway.needed` entry has `"set": true`, and it left
   `data.gateway.missing` (the `next` array no longer names it). Then
   `pnpm everyapp status --json`: the app's `setup.ready` is true and
   `data.fixes` has no `APP_NEEDS_SETUP` for it.
2. Smoke check, in the person's terminal, with the key exported there
   (never in yours; it bills nothing). If they typed it at the prompt in
   step 6 and have no variable, skip to 3; or they read it in hidden in
   their own terminal (README's third way: `read -rs OPENAI_API_KEY &&
   export OPENAI_API_KEY`, paste, Enter; never a typed `export …=`, which
   the shell history keeps) and `unset` it after.

   ```bash
   curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 300
   ```

   Expected: `{"object":"list","data":[{"id":"…","object":"model",…`.
   A 401 body means the key is wrong; a 429 with
   `"type":"insufficient_quota"` means the key is right and the billing
   isn't (see below). Then `unset OPENAI_API_KEY`. A "Restricted" key
   without "List Models: Read" fails this GET while inference still works;
   use the app check instead.
3. The app: open `https://<app>.<app base domain>` and use the feature that
   calls OpenAI. A browser sent to `https://<gateway host>/?setup=<app id>`
   instead (a page's own fetch: 503 with the body
   `{"error":"app_needs_setup","app":"<app id>"}`) is the Gateway's setup
   gate: a required setting is still unset, Verify 1 says which. Any
   response with an `x-everyapp-error` header is the Gateway's, and the
   header names the code: 503 `ai_provider_not_configured` means it holds
   no key under that name (behind the gate only an app whose manifest marks
   `openai` `optional: true` opens in that state and sees this); a 401
   `missing_caller_identity` or `caller_identity_invalid` means the
   call didn't carry the app's identity (an app or SDK problem, nothing to
   set). A response without the header is OpenAI's, status and body
   unchanged. In the app's code the call is
   `createGatewayFetch({ env, for })` to
   `http://every-app-gateway.internal/api/ai/openai/v1/chat/completions`.
4. The Gateway's logs, when the app's error isn't clear: Cloudflare
   dashboard, README's path: **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**
   streams now (nothing stored, 10 viewers at most); Workers Logs is on
   for the Gateway, so the same page keeps them too. Each OpenAI call logs
   `ai.proxy.usage` with `provider`, `appId`, `route`, `model`, `status`,
   `requestId` (OpenAI's `x-request-id`) and `usage`; a connection that
   failed logs `ai.proxy.upstream_failed`; never the prompt or the key.
   `cf` has no Worker tail command (`cf workers --help` lists none);
   `npx wrangler tail every-app-gateway` streams the same (wrangler isn't
   in the checkout: npx fetches it, and it asks for its own Cloudflare
   login the first time; unverified whether cf's login carries over).

## If it fails

| Error or symptom                                                                | Meaning                                                                                                                            | What to do                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_VALUE_REQUIRED` from `secret set`                                       | nothing was piped and there is no terminal to ask in                                                                               | one of README's three ways: the person's terminal, a pipe, or `--from-env`                                                                                                                                                                                       |
| `SECRET_SEVERAL_NAMES`                                                          | several names with `--from-env` or a pipe, which carry one value                                                                   | one call per name                                                                                                                                                                                                                                                |
| `SECRET_EMPTY`                                                                  | the `--from-env` variable is unset or empty in your process                                                                        | the person reads it in hidden (README's third way) in the shell that runs the command, or types it at the prompt                                                                                                                                                  |
| `SECRET_NOT_DECLARED` with `data.didYouMean`                                    | the name is misspelt                                                                                                               | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED`                                                           |
| `CONFIRMATION_REQUIRED` from `secret unset --json`                              | no `--yes`, and no terminal to ask in                                                                                              | that is the ask: show it to the person; rerun with `--yes` only if they say so                                                                                                                                                                                   |
| a browser opening the app is sent to `https://<gateway host>/?setup=<app id>`; any other request gets 503 with the body `{"error":"app_needs_setup","app":"<app id>"}` | the Gateway's setup gate: a required setting of the app is still unset (this key, `AI_PROXY_EXTRA_ROUTES` when the manifest has `ai.routes`, or another the manifest requires) | `pnpm everyapp secret list <app id> --json`: set what `data.app.setup.command` names; Verify step 1 |
| 503, `x-everyapp-error: ai_provider_not_configured`                             | the Gateway holds no `OPENAI_API_KEY` (behind the setup gate an app whose manifest requires `openai` doesn't open in this state; one that marks it `optional: true` sees this) | `secret set` it; then Verify step 1                                                                                                                                                                                                                              |
| 400 `ai_request_invalid`                                                        | an inference POST whose body isn't a JSON object, or a malformed path                                                              | an app bug; nothing to set                                                                                                                                                                                                                                       |
| 403 `provider_not_allowed`                                                      | the app's manifest `providers` doesn't list `openai`                                                                               | add it and `pnpm everyapp deploy --json`                                                                                                                                                                                                                         |
| 403 `ai_route_not_allowed`                                                      | not an inference POST, and the path isn't covered by both `ai.routes` and `AI_PROXY_EXTRA_ROUTES`                                  | step 7 with the union including that path, and `ai.routes` in the manifest, then deploy                                                                                                                                                                          |
| 403 `model_not_allowed`                                                         | the manifest's `ai.models` doesn't list the model                                                                                  | add it there and deploy                                                                                                                                                                                                                                          |
| 502 `ai_upstream_failed`                                                        | `api.openai.com` didn't answer                                                                                                     | retry; check https://status.openai.com                                                                                                                                                                                                                           |
| OpenAI 401 "Incorrect API key provided"                                         | the key is wrong: a typo, trailing text, a revoked key, an expired one (its Expiration date passed), or a deleted project          | a new key (step 5), `secret set` again; see Rotate                                                                                                                                                                                                               |
| OpenAI 401 "You must be a member of an organization to use the API"             | the account is in no organization                                                                                                  | the person asks an organization owner to invite them, or OpenAI support                                                                                                                                                                                          |
| OpenAI "insufficient permissions … Missing scopes: model.request"               | a "Restricted" key without "Model Capabilities: Request"                                                                           | a new key with Permissions "All" (step 5), `secret set` again                                                                                                                                                                                                    |
| OpenAI 403 "Country, region, or territory not supported"                        | the call's origin isn't served; the Gateway runs on Cloudflare's edge                                                               | the person checks https://developers.openai.com/api/docs/supported-countries; nothing to set                                                                                                                                                                     |
| OpenAI 403 "Your organization must be verified to use the model …"              | that model needs API Organization Verification (GPT Image models; summaries with the latest reasoning models); no model page says so, only this error | **Person:** https://platform.openai.com/settings/organization/general, "Verify Organization", a government ID from a supported country (one ID verifies one organization every 90 days; not every organization qualifies), then up to 15 minutes; Verify step 3 again. Or a model that isn't gated, in `ai.models` |
| OpenAI 429, `type` `insufficient_quota` or `code` `credit_balance_exhausted`    | the key is valid but the organization has no prepaid credits: none bought yet, a balance still posting, or credits expired         | step 3; wait a few minutes after buying; https://platform.openai.com/settings/organization/limits                                                                                                                                                                |
| OpenAI 429 `project_spend_limit_exceeded` or `organization_spend_limit_exceeded` | a hard spend limit the person set was reached                                                                                      | raise or remove it on the limits page, or the project's settings                                                                                                                                                                                                 |
| OpenAI 429 `organization_usage_limit_exceeded`                                  | the tier's monthly ceiling                                                                                                         | more credit purchases raise the tier; or OpenAI support                                                                                                                                                                                                          |
| OpenAI 429 "Rate limit reached" or `slow_down`                                  | requests too fast for the tier                                                                                                     | follow `Retry-After`; a higher tier                                                                                                                                                                                                                              |
| OpenAI 503 `server_is_overloaded`                                               | the model is overloaded                                                                                                            | retry after `Retry-After`                                                                                                                                                                                                                                        |
| `done`, but the app still says 503                                              | the app got the error before the Gateway's new version served                                                                      | try once more; then Verify step 1                                                                                                                                                                                                                                |

## Rerun, rotate, remove

- Rerun: every step is safe to repeat; `secret set` replaces the value.
  Interrupted or back later: start at Verify and continue at the first
  step that isn't done.
- Rotate: step 5 for a new key (OpenAI recommends an Expiration date and a
  regular rotation: make the replacement before the old key expires), step
  6, Verify, then revoke the old key at https://platform.openai.com/api-keys
  (its row's delete action). Apps switch at the Gateway's next request.
- Remove: `pnpm everyapp secret unset OPENAI_API_KEY --json`. Without
  `--yes` it stops with `CONFIRMATION_REQUIRED`: that is the ask; show it
  to the person and rerun with `--yes` only if they say so. The `done`
  event's `data.gateway.names` lists what was removed; when nothing held
  the name, `done` has `data.removed: false`. Then revoke the key at
  https://platform.openai.com/api-keys: a key the Gateway no longer holds
  is still a key. The same for `AI_PROXY_EXTRA_ROUTES` (it empties the list
  for every app). Apps whose manifest requires `openai` (or, through
  `ai.routes`, the routes list) then need setup again: the Gateway closes
  them until the setting is back (`status` says so, with this file's
  path); an app that marks the provider `optional: true` keeps opening and
  answers 503 `ai_provider_not_configured` on each call instead.

## Sources

Verified on 2026-10-23:

- https://developers.openai.com/api/docs/guides/error-codes (401, 403 with the supported-countries link, 429 codes, `credit_balance_exhausted`, 503)
- https://developers.openai.com/api/docs/guides/rate-limits (usage tiers Free, Build, Launch, Grow; Free needs an allowed geography; `x-ratelimit-*` headers)
- https://developers.openai.com/api/docs/guides/rbac ("Model capabilities: Request", "Responses API: Read, Write", "List models: Read"; `/v1/models` needs `api.model.read`)
- https://developers.openai.com/api/docs/api-reference/models/list (the smoke check and its response)
- https://developers.openai.com/api/docs/guides/your-data (abuse-monitoring logs kept up to 30 days on every endpoint; a Response is kept 30 days when `store` is true; Zero Data Retention needs OpenAI's approval and forces `store` to false) and https://developers.openai.com/api/docs/api-reference/responses/create (`store`: "Whether to store the generated model response for later retrieval via API", true when omitted)
- https://developers.openai.com/api/docs/guides/production-best-practices (projects, key expiration and rotation, limits page)
- https://developers.openai.com/api/docs/guides/spend-limits (organization and project spend limits; credits are the organization's)
- https://developers.openai.com/api/docs/guides/image-generation and https://developers.openai.com/api/docs/guides/reasoning (API Organization Verification for GPT Image models and reasoning summaries)
- https://developers.openai.com/api/docs/supported-countries
- https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing and https://help.openai.com/en/articles/8264778-what-is-prepaid-billing (the organization's billing overview, "Add payment details", minimum $5, default $10, auto-reload with its threshold, restore-to amount and monthly limit, one-year expiry), https://help.openai.com/en/articles/8156019-how-can-i-start-using-the-api and https://help.openai.com/en/articles/9039756-billing-settings-in-the-api-platform (both link the billing overview as `/settings/organization/billing/overview`); help.openai.com refuses direct fetches: read through a reader proxy, or search snippets
- https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform (the Default project takes no members or service accounts, "Create project" with name, description and website, owners only; the Projects page is https://platform.openai.com/projects; reader proxy)
- https://platform.openai.com signed out (rendered through a reader proxy: "Sign up or login with an OpenAI account"); OpenAI's own pages cite no `/signup` URL, only https://platform.openai.com/login
- https://help.openai.com/en/articles/8867743-assign-api-key-permissions (All, Restricted, Read Only; service account keys get no permission controls at creation; snippets)
- https://help.openai.com/en/articles/8983040-what-does-phone-verification-look-like and https://help.openai.com/en/articles/8983024-can-i-use-a-premium-number-landline-google-voice-or-other-voip-phone-number (phone verification at the first key, SMS or WhatsApp, no VoIP; snippets)
- https://help.openai.com/en/articles/10910291-api-organization-verification (government ID; Settings, Organization, General, "Verify Organization"; snippets) and https://techcrunch.com/2025/04/13/access-to-future-ai-models-in-openais-api-may-require-a-verified-id/ (one ID per organization every 90 days; not every organization qualifies)
- https://help.openai.com/en/articles/4936824 (sign-in with Google, Microsoft or Apple; snippets)
- https://community.openai.com/t/missing-scopes-model-request-on-restricted-api-key/1371602 (the Restricted dialog's labels and the `model.request` error), https://community.openai.com/t/unable-to-use-api-phone-number-reached-max-uses/625230 (three accounts per number, deleted ones counted), https://github.com/openai/codex/issues/1982 (the verification error's text)
- https://help.specinnovations.com/openai-api-key (third party: the key dialog's fields)
- https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ (the dashboard path, `npx wrangler tail`, 10 viewers, nothing stored) and wrangler's `src/tail/index.ts` (the Worker name as an optional positional)
- In this checkout: `apps/every-app-gateway/src/server/ai-proxy.ts` (routes, `store: false`, `AI_PROXY_EXTRA_ROUTES` parsing, refusal codes, log events), `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` (identity refusals on `/api/ai/*`), `apps/every-app-gateway/cloudflare.config.ts` (Workers Logs on), `packages/perimeter/src/manifest/manifest.ts` (`ai.routes`), `packages/sdk/src/internal/gatewaySettings.ts`, `packages/sdk/src/internal/appSettings.ts` (`AppSetup`: `unmet`, `settings`, `groups`, `command`; the `ai-routes` entry and its `why`; `needOf`: a plain provider id is required, `optional: true` isn't; `setup/openai.md` from the provider registry, `packages/sdk/src/internal/aiProviders.ts`), `packages/cli/src/commands/secret/index.ts` (`secret list <app>` from anywhere, `data.app.setup`, `data.app.deployed`, `APP_NOT_FOUND`, `SECRET_NOT_DECLARED` and its `data.rerun`, `data.gateway.names`, `data.gateway.needed`, `data.removed`), `packages/cli/src/lib/app/settings.ts` (the `Guide:` line), `packages/cli/src/commands/status/problems.ts` (`APP_NEEDS_SETUP`), `apps/every-app-gateway/src/server/app-needs-setup.ts` (the setup gate: the redirect to `/?setup=<app id>` and 503 `app_needs_setup`), `packages/cli/src/lib/secretValue.ts` (`SECRET_VALUE_REQUIRED`, `SECRET_SEVERAL_NAMES`, `SECRET_EMPTY`), `packages/cli/src/lib/output/prompt.ts` (`CONFIRMATION_REQUIRED`), `landing-page/content/docs/create-an-app.mdx`, `docs/capabilities.md`
