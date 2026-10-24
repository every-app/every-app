# OpenRouter for the Gateway

OpenRouter is one API key in front of many model providers (OpenAI,
Anthropic, Meta, Moonshot and others), prepaid in US dollars. The Gateway
holds the key as `OPENROUTER_API_KEY` and proxies `/api/ai/openrouter/...`
to `openrouter.ai` for every app that lists the `openrouter` provider, so no
app holds it. OpenSEO uses it for SAM (the in-app SEO agent), prompt
suggestions and website research. agentic-inbox uses it unless its Worker
was built with `AI_PROVIDER=workers-ai` (its `cloudflare.config.ts` defaults
the variable to `openrouter`; the manifest comment saying Workers AI is the
default is stale; the other provider is [workers-ai.md](workers-ai.md)). At
the end the person has an OpenRouter account with credits, one key with a
spending limit and no expiry, the key on the Gateway, and a model answering
inside the app.

## Settings

| NAME                 | Required or optional                                   | What it holds                                                                              |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY` | required by every app whose manifest lists `openrouter` | the API key exactly as OpenRouter showed it once at creation (`sk-or-v1-...`, one line) |

The Gateway sends the key only to `https://openrouter.ai`, and only on POST
to `/api/v1/chat/completions`, `/api/v1/completions`, `/api/v1/responses`
and `/api/v1/embeddings`.

## Costs and plans

As of October 2026: an account is free; credits are prepaid in USD and pay
for inference at the providers' own prices, with no markup. Buying credits
costs a fee: 5.5% of the amount with a minimum fee of $0.80 by card or
AliPay, 5% flat in USDC; at least $5 per purchase, at most $25,000; the fee
is not refunded. OpenRouter may expire unused credits 365 days after
purchase. The models the two apps use are all paid (per million tokens,
from the public model list on 2026-10-23): `openai/gpt-5.6-luna` $0.20 in /
$1.20 out, `anthropic/claude-haiku-5.5` $0.10 / $0.50,
`meta-llama/llama-4-scout` $0.10 / $0.30, `meta-llama/llama-3.1-8b-instruct`
$0.05 / $0.08, `moonshotai/kimi-k2.6` $0.65 / $3.41, `minimax/minimax-m3`
$0.30 / $1.20. Paid models have no platform request cap; a negative balance
makes every call fail. `:free` models are capped at 20 requests a minute and
50 a day (1,000 a day once $10 of credits were ever bought), and the apps
never ask for one. $10 is a sensible first top-up: the $0.80 minimum fee
makes $5 cost $5.80 and $10 cost $10.80, and either is enough to set up and
try both apps.

## Only a person can

- Sign up or sign in at openrouter.ai and accept its terms.
- Buy credits (a card, AliPay or USDC) and decide how much.
- Choose the account's privacy settings (which providers may train on
  prompts; zero data retention per model group).
- Create the key, pick its spending limit and expiry, and copy it off the
  screen.
- Delete a key on OpenRouter's side.

## Before you start

1. `pnpm everyapp secret list openseo --json` and
   `pnpm everyapp secret list agentic-inbox --json`, from any directory, one
   per app the person has (`APP_NOT_FOUND`, "<app> isn't deployed to this
   Gateway yet", means that app isn't deployed: the key can still be set
   now, from any directory, and the app uses it on its first deploy). The
   `OPENROUTER_API_KEY` entry in `data.app.setup.unmet` (`names`,
   `need.kind` `required`, `holder` `gateway`, `setup`
   `setup/openrouter.md`) means this file applies, and the app doesn't open
   until it is set: the Gateway lists it as needing setup, sends a browser
   opening `https://<app>.<app base domain>` to its setup dialog and
   answers anything else 503 `app_needs_setup`. `data.app.setup.command`
   is the one `pnpm everyapp secret set …` naming every missing Gateway
   setting (`data.next` repeats it). The entry in `data.app.setup.settings`
   with `"set": true` means it is set already: ask before replacing it; a
   value can't be read back, so replacing means a new key (see Rerun,
   rotate, remove). The older fields still say the same:
   `data.gateway.needed[]` has `{ "name": "OPENROUTER_API_KEY", "required":
   true, "set": false }` and `data.gateway.missing` names it while unset.
   This is how an agent lands here: `status` (under "<app> needs setup") and
   `secret list <app id>` (under the unmet setting) print `Guide:
   .claude/skills/everyapp/setup/openrouter.md`, and `secret list --json`
   carries the path as the entry's `setup` (in the
   checkout: `packages/cli/skills/everyapp/setup/openrouter.md`).
   agentic-inbox: its manifest lists `providers: ["workers-ai",
   "openrouter"]` as plain ids, so both are `need.kind` `required` and
   `data.app.setup.groups` is `[]` (an any-of group appears only when a
   manifest writes the entries as `{ id, anyOf: "<group name>" }`; the
   inbox's doesn't). So `WORKERS_AI_API_TOKEN` is in `unmet` and in
   `command` beside this key, and the inbox doesn't open until both are set,
   though a Worker on OpenRouter never calls Workers AI:
   [workers-ai.md](workers-ai.md) is part of opening the inbox today, not an
   option (its email sender is too: [email.md](email.md)). An app that
   doesn't need OpenRouter: stop here.
2. `pnpm everyapp status --json`: in the `done` event, `data.installed` and
   `data.claimed` are true, `data.gatewayUrl` is `https://<gateway host>`,
   and `data.apps[]` has an entry with `"id": "openseo"` or
   `"id": "agentic-inbox"` and `"bound": true`, carrying the same `setup`;
   while a required setting is missing `data.fixes` has `APP_NEEDS_SETUP`
   for the app (severity `warning`, headline "<app> needs setup", `run` the
   same command). Not installed or no owner: [gateway.md](gateway.md) first.

## Steps

1. **You:** run the two checks above and tell the person what is set and
   what is missing. Say what OpenRouter is for in one line (the model behind
   SAM, or the inbox agent). Ask whether they already have an OpenRouter
   account or key: an account skips 2 (and 3 when it has credits); a key
   whose value they still have (OpenRouter shows it once, at creation) goes
   in with `--from-env` from their shell (step 6's alternative) and skips 5,
   with two checks: the key OpenRouter made for them during onboarding has a
   $100 limit and expires after 180 days, and Verify 2 shows any key's
   `data.expires_at`. Then give steps 2-6 as one list, the default path only
   (the alternatives in 5 and 6 when the answer calls for them), and wait
   after 6.
2. **Person:** open https://openrouter.ai/sign-in. Sign in, or choose Sign
   Up and create an account: Google, GitHub, or an email address (a code or
   link is sent, then a password); a MetaMask wallet and passkeys are
   offered too. The page needs JavaScript. Done when the top-right menu
   shows their account.
3. **Person:** open https://openrouter.ai/settings/credits. Click the
   button to add credits (its goal: top up the prepaid balance), enter an
   amount ($10 to start; $5 is the minimum), pay by card, AliPay or USDC.
   Done when the page shows the new balance. Without credits every call
   answers 402.
4. **Person (optional, read it with them):** open
   https://openrouter.ai/settings/privacy. One set of toggles decides
   whether OpenRouter may route to providers that train on prompts,
   separately for paid and free models; a second set switches zero data
   retention on per model group (Anthropic, OpenAI, Google, all other
   models), which drops that group's first-party endpoints. Leaving
   training off is fine for the apps' models (unverified for every provider
   of each model; the public API doesn't show it). A model with no endpoint
   left under the policy fails with a 404 "0 endpoints out of N requested
   are available matching your guardrail restrictions and data policy ..."
   (older wording: "No endpoints found matching your data policy").
5. **Person:** open https://openrouter.ai/settings/keys. Click **Create
   Key** (label unverified; OpenRouter's docs name no button; its goal: a
   new key for the Gateway). Name it `every-app gateway <gateway host>`.
   Credit limit: an amount they are happy to lose, e.g. $20. Limit reset:
   monthly; without a reset the limit is for the key's lifetime, and a key
   that reaches it is refused until the limit is raised on the key's page
   or, with a reset, until it resets. Expiration: No expiration, or write
   the date down as the rotation deadline (an expired key fails with 401).
   Create. The key is shown once: copy it now and keep the tab open until
   step 6 is verified. Alternative, README way two, when the person
   exported a management key (made at
   https://openrouter.ai/settings/management-keys) before starting you:
   `curl -s -X POST https://openrouter.ai/api/v1/keys -H "Authorization: Bearer $OPENROUTER_MANAGEMENT_KEY" -H 'Content-Type: application/json' -d '{"name":"every-app gateway <gateway host>","limit":20,"limit_reset":"monthly"}' | jq -r '.key' | pnpm everyapp secret set OPENROUTER_API_KEY --json`
   creates the key and sets it without showing it (the response's
   top-level `key`; `data.hash` names it later). A management key can
   create and delete every key and read spend, so prefer the console unless
   they already have one.
6. **Person:** README way one, the person types it. In a second terminal, in
   the `every-app` folder: `pnpm everyapp secret set OPENROUTER_API_KEY`.
   It asks `Value for OPENROUTER_API_KEY` with a hidden prompt; paste, Enter.
   It prints that `OPENROUTER_API_KEY` is set on the Gateway. Then they tell
   you. Alternative, README way three, when the key is in a variable the
   person exported before starting you:
   `pnpm everyapp secret set OPENROUTER_API_KEY --from-env OPENROUTER_API_KEY --json`
   (the `done` event's `data.gateway.names` contains `OPENROUTER_API_KEY`;
   `data.gateway.versions` maps the Gateway Worker to its new version id).
   Never `echo` the variable and never put the key on a command line. The
   change is live at once; no deploy.
7. **You:** verify (next section). The tab from step 5 can be closed once
   the key answers there (Verify 2 on the `--from-env` path, otherwise 3).
8. **You, agentic-inbox only:** the provider is chosen when its Worker is
   built, from the `AI_PROVIDER` variable of the deploying shell; the
   default is `openrouter`. Pass it explicitly on every deploy anyway, in
   the app's directory: `AI_PROVIDER=openrouter pnpm everyapp deploy --json`
   (its manifest comment still says Workers AI is the default; it isn't).
   OpenSEO needs no redeploy.

## Verify

1. `pnpm everyapp secret list <app id> --json` for each app (`openseo`,
   `agentic-inbox`), from anywhere: the `OPENROUTER_API_KEY` entry in
   `data.app.setup.settings` has `"set": true` and has left
   `data.app.setup.unmet`; `data.app.setup.ready` is true once nothing else
   of the app's is missing (OpenSEO: its DataForSEO and Context keys;
   agentic-inbox: `WORKERS_AI_API_TOKEN`, which stays in `unmet` and in
   `command` because its manifest requires both providers, with no any-of
   group, and its email sender). In the older fields, `data.gateway.names`
   lists the key, its `data.gateway.needed` entry has `"set": true` and it
   left `data.gateway.missing` (for an app not deployed yet, the root
   `pnpm everyapp secret list --json` shows `data.gateway.names` and that is
   the check). Then `pnpm everyapp status --json`: each app's `setup.ready`
   is true and `data.fixes` has no `APP_NEEDS_SETUP` for it once everything
   else is set; until then the fix stays, naming only what is still missing.
2. Smoke check, only when the key went in with `--from-env` (step 6's
   alternative: the variable already exists in the person's shell). After
   the hidden prompt nothing is exported, and after the management-key path
   nobody but the Gateway holds the key: don't ask them to export it for a
   check; go to 3, the app, where a $0 balance also shows (as a 402). In
   their terminal, never yours:
   `curl -s -w '\n%{http_code}\n' https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"`.
   A `{"data":{...}}` body and 200 means the key works: read `data.label`,
   `data.limit` (the step 5 limit, or null), `data.limit_reset` (null means
   a lifetime limit), `data.limit_remaining`, `data.usage`,
   `data.expires_at` (null means never) and `data.is_free_tier` (false once
   credits were ever bought). The balance is not in this response and
   `GET /api/v1/credits` needs a management key: a $0 balance first shows
   as a 402 in 3. An `{"error":...}` body and 401: "User not found." is a
   wrong, disabled or mistyped key; "Missing Authentication header" means
   the variable is empty, so the export failed, not the key. Afterwards:
   `unset OPENROUTER_API_KEY`.
3. The app. OpenSEO: open `https://openseo.<app base domain>`, a project,
   then its SAM page (the project's `/sam` route) and ask something; the
   answer streams. Prompt suggestions and website research use the same key.
   A browser sent to `https://<gateway host>/?setup=openseo` instead means a
   required setting is still unset (Verify 1 says which): behind the
   Gateway's setup gate neither app opens while this key is missing, so the
   refusals below are what a fork whose manifest marks the provider
   `optional: true` sees. OpenSEO's SAM page itself only checks for the
   Gateway binding, so there the turn fails: the Gateway answers 503
   `ai_provider_not_configured`, visible in the browser's network tab or the
   Gateway's logs (4). OpenSEO's own "OPENROUTER_API_KEY is not set" page,
   with a `--for gateway` flag `secret set` doesn't have, shows only in
   local dev. agentic-inbox (built without `AI_PROVIDER=workers-ai`): open
   `https://agentic-inbox.<app base domain>`, a mailbox, and send the agent
   a message; it answers. Its refusal reads "The gateway refused the AI
   call: Provider is not configured: the gateway needs OPENROUTER_API_KEY
   for openrouter. (ai_provider_not_configured)".
4. The Gateway's logs, when the app says nothing useful: every proxied call
   logs one JSON line `{"evt":"ai.proxy.usage","provider":"openrouter","model":...,"status":...,"usage":...}`
   and a failed connection `{"evt":"ai.proxy.upstream_failed",...}`.
   Workers Logs is on for the Gateway Worker: in the Cloudflare dashboard,
   README's path: **Workers & Pages** → `every-app-gateway` → **Observability** (**Logs** on older accounts) → **Live**,
   or the stored logs on the same page (kept 7 days on Workers Paid). `cf workers tail` does not exist in cf 1.0.0-beta.14
   (`cf workers --help`); `cf o11y telemetry live-tail --help` and `cf o11y
   telemetry query --help` are the CLI way, not covered here. `status` is
   OpenRouter's HTTP status: 200 is a billed answer, 402 and 403 are the
   account's problem, not the Gateway's.

## If it fails

| Error or symptom                                                                 | Meaning                                                                                              | What to do                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SECRET_VALUE_REQUIRED`                                                          | `secret set --json` ran with nothing piped and no terminal                                           | one of README's three ways; its `data.rerun` is the `--from-env OPENROUTER_API_KEY` form                        |
| `SECRET_EMPTY`                                                                   | the `--from-env` variable is empty in your shell (exported in theirs, not before you started)        | the person runs the `--from-env` command in their terminal, or the hidden prompt (step 6)                       |
| `SECRET_SEVERAL_NAMES`                                                           | `--from-env` or a pipe with more than one name                                                       | one name per call                                                                                                |
| `SECRET_NOT_DECLARED` with `data.didYouMean`                                     | the name is misspelt (`OPEN_ROUTER_API_KEY`)                                                         | rerun with the name in `data.didYouMean` and the same value source (`--from-env VAR --json`, or the same pipe); `data.rerun` carries only the names, so run as is it stops with `SECRET_VALUE_REQUIRED` |
| `provider_not_allowed` (403)                                                     | the app's `everyapp.config.ts` `providers` doesn't list `openrouter`                                 | add it and redeploy; nothing to set on the Gateway                                                               |
| a browser opening the app is sent to `https://<gateway host>/?setup=<app id>`; any other request gets 503 with the body `{"error":"app_needs_setup","app":"<app id>"}` | the Gateway's setup gate: a required setting of the app is still unset (this key, or another the manifest requires: agentic-inbox's `WORKERS_AI_API_TOKEN`, OpenSEO's DataForSEO and Context keys) | `pnpm everyapp secret list <app id> --json`: set what `data.app.setup.command` names; Verify 1 |
| `ai_provider_not_configured` (503, `x-everyapp-error`)                           | the Gateway holds no `OPENROUTER_API_KEY` (behind the setup gate an app whose manifest requires `openrouter` doesn't open in this state; one that marks it `optional: true` sees this) | step 6, then Verify 1; check the name                                                                            |
| `model_not_allowed` (403)                                                        | the app's manifest `ai.models` doesn't list the model it asked for (agentic-inbox's `AGENT_MODEL`)   | use a listed model, or add it to `ai.models` and redeploy; OpenSEO lists none, so any model passes               |
| `ai_route_not_allowed` (403)                                                     | the app called a path that isn't inference                                                           | only the four routes under Settings; nothing to set                                                              |
| `ai_upstream_failed` (502)                                                       | the Gateway couldn't reach openrouter.ai                                                             | retry; read the `ai.proxy.upstream_failed` log line                                                              |
| `integration_not_configured`                                                     | a different capability's setting is missing: DataForSEO, Context or email sending, not OpenRouter    | [dataforseo.md](dataforseo.md), [context.md](context.md), [email.md](email.md)                                   |
| OpenRouter 401 "User not found."                                                 | the key is wrong, disabled, deleted, or pasted with a stray character                                | create a new key (Rerun, rotate, remove)                                                                         |
| OpenRouter 401 "API key expired"                                                 | the key's Expiration (step 5) passed (wording from the management-key docs; unverified for an inference key) | a new key with No expiration (Rotate)                                                                    |
| OpenRouter 401 "Missing Authentication header" / "No cookie auth credentials found" | the header was sent empty (the variable isn't exported in that terminal) or not at all; the key wasn't judged | redo the export in one terminal, then Verify 2; or step 6                                               |
| OpenRouter 402 "insufficient credits"                                            | the balance is zero or negative                                                                      | add credits at https://openrouter.ai/settings/credits                                                            |
| OpenRouter 403 with `limit_source: openrouter_key_limit`                         | the key's own credit limit (step 5) is spent; `resets_at: null` means a lifetime limit               | raise it on the key's page (the only fix for a lifetime limit), or wait for `resets_at`                          |
| OpenRouter 403 guardrail or moderation (`permission_denied`)                     | the prompt was flagged, or a workspace guardrail blocked the request; not a setup problem            | nothing to set                                                                                                   |
| OpenRouter 404 "0 endpoints out of N requested are available matching your guardrail restrictions and data policy" (older: "No endpoints found matching your data policy") | the privacy settings (training, or a zero-data-retention toggle for the model's group) exclude every endpoint of that model | https://openrouter.ai/settings/privacy, or another model                               |
| OpenRouter 429                                                                   | rate limited: a `:free` model's cap, or the upstream provider                                        | the apps' models are paid, so retry; OpenRouter routes to another provider when it can                           |
| OpenRouter 502 / 503                                                             | the model is down, or no provider meets the routing requirements (`zdr`, provider order)             | retry later; OpenSEO's MiniMax fallback restricts routing to zero-data-retention endpoints (Together first, fallbacks on), so a 503 there means no ZDR provider is up |
| OpenRouter 403 "This model is not available in your region"                      | OpenRouter refuses OpenAI, Anthropic and Google models from some countries (community reports, 2026; not in OpenRouter's docs) | OpenSEO switches SAM to `minimax/minimax-m3` by itself; agentic-inbox's agent defaults to Claude Haiku, so redeploy it with `AGENT_MODEL=moonshotai/kimi-k2.6 AI_PROVIDER=openrouter pnpm everyapp deploy --json` (or `meta-llama/llama-4-scout`, also in its `ai.models`) |
| agentic-inbox: "AI isn't set up on this gateway (OPENROUTER_API_KEY) or in .dev.vars" | no Gateway binding and no local key: `everyapp dev`, whose ready block's `Dev vars` line names the keys `.dev.vars` is missing (the inbox's names both providers' settings; on OpenRouter only `OPENROUTER_API_KEY` is needed) | the person adds `OPENROUTER_API_KEY=...` to the app's `.dev.vars` (gitignored) in their own editor, with their own key, billed to them; never ask for the value and never write that file yourself |
| OpenSEO SAM page: "OPENROUTER_API_KEY is not set for this deployment yet"        | the same, in local dev (its `Dev vars` line names the key too); behind the Gateway the page never says this (and its `--for gateway` hint is stale) | `.dev.vars` as above, by the person                                                                       |

## Rerun, rotate, remove

- **Rerun.** Every step is safe to repeat: `secret set` replaces the value,
  the keys page shows what exists. Start from Verify and continue at the
  first step that isn't done.
- **Rotate.** Create a new key (step 5, No expiration), set it (step 6), run
  Verify, then the person deletes the old key at
  https://openrouter.ai/settings/keys. Apps pick up the new value on their
  next call; no deploy. A key with an Expiration date needs this before the
  date.
- **Remove.** `pnpm everyapp secret unset OPENROUTER_API_KEY --json` (it asks
  at a terminal; with `--json` add `--yes` only when the person said so).
  Then the person deletes the key on OpenRouter: a key the Gateway no longer
  holds is still a key. Apps whose manifest requires `openrouter` then need
  setup again: the Gateway closes them until the key is back (OpenSEO and
  agentic-inbox both, and the inbox's `AI_PROVIDER=workers-ai` build
  changes nothing: the manifest, not the build, says what is required;
  `status` says so, with this file's path). An app that marks the provider
  `optional: true` keeps opening and gets `ai_provider_not_configured` on
  each call instead.

## Sources

- https://openrouter.ai/docs/api_reference/authentication (keys at `/settings/keys`, credit limit and reset on a key, onboarding keys' $100 limit and 180 days, Bearer header)
- https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md (`GET /api/v1/key` and its fields; no balance)
- https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key.md (`POST /api/v1/keys`: `limit`, `limit_reset`, `expires_at`; top-level `key` shown once; management key required)
- https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md (`GET /api/v1/credits` needs a management key; 403 otherwise)
- https://openrouter.ai/docs/guides/overview/auth/management-api-keys (`/settings/management-keys`, Create New Key, no completion calls, 401 "API key expired")
- https://openrouter.ai/docs/api_reference/limits (free-model caps, paid models uncapped, negative balance, `is_free_tier`)
- https://openrouter.ai/docs/api_reference/errors-and-debugging (401, 402, 403 guardrail and `permission_denied`, 429, 502, 503; key-limit 403 with `limit_source`, `scope`, `resets_at`)
- https://openrouter.ai/blog/announcements/simplifying-our-platform-fee/ and https://openrouter.ai/terms §4.1-4.2 (5.5% with a $0.80 minimum, 5% in crypto; $5 to $25,000 a purchase; 365-day expiry); https://openrouter.ai/docs/faq (payment methods, no inference markup)
- https://openrouter.ai/docs/guides/privacy/provider-logging (`/settings/privacy`, paid and free settings), https://openrouter.ai/docs/guides/features/zdr (ZDR toggle per model group), https://openrouter.ai/docs/guides/routing/provider-selection (404 when no provider matches; `order`, `zdr`, `allow_fallbacks`)
- https://github.com/NousResearch/hermes-agent/issues/133850 (2026-10-06; the data-policy 404 body, old and new wording)
- https://clerk.openrouter.ai/v1/environment (sign-in options; fetched 2026-10-23)
- https://linux.do/t/topic/1846933 and https://github.com/anomalyco/opencode/issues/19117 (2026; 403 "not available in your region" for OpenAI, Anthropic and Google models through OpenRouter)
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (Workers & Pages, the Worker, Observability; 7 days on Paid); `cf o11y telemetry --help` (live-tail, query)
- https://openrouter.ai/docs/guides/routing/model-variants/free.md (`:free` variants)
- https://openrouter.ai/api/v1/models (public; the six model ids and prices above, fetched 2026-10-23)
- Console pages checked on 2026-10-23: https://openrouter.ai/settings/keys (via `/workspace-redirect/keys`), https://openrouter.ai/settings/credits and https://openrouter.ai/settings/privacy all go to sign-in when signed out; the older `/docs/api-reference/...` and `/docs/features/...` URLs 308-redirect to the pages above
- In code: `apps/every-app-gateway/src/server/app-gateway-entrypoint.ts` (`provider_not_allowed`), `apps/every-app-gateway/src/server/capabilities/email.ts` (`integration_not_configured`), `apps/every-app-gateway/src/server/app-needs-setup.ts` (the setup gate: the redirect to `/?setup=<app id>` and 503 `app_needs_setup`), `packages/sdk/src/internal/gatewaySettings.ts` (each provider's key is `required`), `packages/sdk/src/internal/appSettings.ts` (`AppSetup`: `unmet`, `settings`, `groups`, `command`; `needOf`: a plain provider id is required, `anyOf` makes a group; `setup/openrouter.md` from the provider registry, `packages/sdk/src/internal/aiProviders.ts`), `packages/cli/src/commands/secret/index.ts` (`secret list <app>` from anywhere, `data.app.setup`, the kept `data.gateway.needed` and `missing`, `APP_NOT_FOUND`), `packages/cli/src/lib/app/settings.ts` (the `Guide:` line), `packages/cli/src/commands/status/problems.ts` (`APP_NEEDS_SETUP`), `packages/cli/src/commands/dev/ready.ts` (the `Dev vars` line); agentic-inbox's `everyapp.config.ts` (`providers: ["workers-ai", "openrouter"]` as plain ids), `cloudflare.config.ts` (`AI_PROVIDER` default) and `workers/everyapp/gateway.ts` (`AGENT_MODEL`); OpenSEO's `everyapp.config.ts` (`providers: ["openrouter"]`), `src/server/lib/openrouter.ts` (ZDR routing, blocked countries) and `src/serverFunctions/samAccess.ts` (the SAM gate)
