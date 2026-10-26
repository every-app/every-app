# Capabilities the gateway holds

An app often needs a third-party API that isn't AI: DataForSEO for SEO data,
Context.dev for rendering pages, a social network's OAuth client, a way to
send email, Google's and Microsoft's mail and calendar, later GitHub. The
gateway holds the credential once, an app lists the capability in its
manifest, and the app calls through the gateway. No app holds the key. Per
installation, an app has its own secrets (`secret set NAME --app <id>`) and
the addresses it sends as and receives at (`everyapp email set`, below).

This is phase 0 of the integrations design (the integrations-hub research of
October 2026, which the repository no longer carries):
**API-key providers whose key the gateway holds**, **OAuth clients** the
gateway holds for social networks and for Google's and Microsoft's mail and
calendar, whose token endpoints it completes for
apps ([below](#oauth-clients)), and **gateway services**, things the gateway
does itself for apps (sending email, [below](#gateway-services-email);
listing the organization's members, [below](#gateway-services-members)).
Organization-held OAuth accounts and admin approval come in later phases and
keep the same manifest entry, binding route and SDK call.

AI providers are entries of the same catalog (`mode: "ai"`) and stay
separate in how an app reaches them:
`providers: ["openai", "openrouter", "workers-ai"]` and the
`/api/ai/<provider>` proxy, with their model and route allowlists. A gateway may also register API-key providers the catalog
doesn't have, as rows of its own ([Provider registry](#provider-registry)).

What comes next is designed, not built: the October 2026 redesign review
folds AI providers into this model behind one route and one SDK fetch, and the
Google design (both documents were removed from the repository in #433, on
2026-10-24)
adds organization-held OAuth accounts under an operator-held client. Both were
re-aligned on 2026-10-16 with the hosted-platform research
(`docs/research/2026-10-hosted-platform/`, PR #299; all three documents deleted from
main on 2026-10-24, git history at 5ef30882): in hosted, first-party apps share one Worker per app and third-party
apps get one Worker per organization on Workers for Platforms, and the gateway
learns the organization per call. Both documents were written when the
manifest key was `integrations` with `as` and `background` on each entry; read
them with this document's `capabilities` and
`{ access, why, docs, optional, anyOf }`.

## The four kinds

One catalog (`CAPABILITIES` in `packages/sdk/src/internal/capabilities.ts`)
defines every provider the gateway holds a credential for, built in; its
`mode` is the kind. Three kinds are capabilities: they take the same
manifest entry, `capabilities: { <id>: { access, scopes, why, docs, optional, anyOf } }`
(`access`, `scopes` for a client with scope sets ([OAuth clients](#oauth-clients)),
and the need fields of [docs/manifest-settings.md](manifest-settings.md)),
travel the app's private binding to the gateway under
`/api/integrations/<id>/...`, and answer `GET /api/integrations/<id>`
(`integrationStatus`) without calling out. The fourth, `ai`, is an AI
provider, which is never a capability: an app lists it under `providers` and
reaches it at `/api/ai/<id>/...`. The strict validator refuses
`capabilities: { openrouter }` ("list it under providers, not
capabilities"), `/api/integrations/openrouter/…` answers 400
`invalid_integration_route`, and the settings model reads it under
`providers` only (pinned in `apps/every-app-gateway/src/server/provider-rules.test.ts`,
`packages/perimeter/src/manifest/manifest.registry.test.ts` and
`packages/sdk/src/internal/appSettings.registry.test.ts`): a key on an
inference host reaches the account's files, batches and keys too, so only the
AI proxy's inference routes may use it.

| Kind           | Capabilities                                          | What the gateway does                                                             | The app calls                                                                            | Access  | Status adds                     |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------- | ------------------------------- |
| `api_key`      | `dataforseo`, `context`, and the providers a gateway registers ([Provider registry](#provider-registry)) | puts its key on calls to the provider's own hosts, with the methods its entry allows (read methods; write methods under a write grant, where the provider offers write) | `integrationFetch({ env, provider, for })` on the provider's real URLs                   | `read` (a registered provider may offer `write`) |                                 |
| `ai`           | `openai`, `openrouter`, `workers-ai` ([AI providers](#ai-providers)) | puts its key on inference calls to the provider's origin, with the AI proxy's rules (inference routes, `store: false`, the model allowlist) | `createGatewayFetch({ env, for })` on `/api/ai/<id>/...`; listed under `providers`, not `capabilities` | | none here: `GET /api/integrations/<id>` is 400 |
| `oauth_client` | 16 social networks, Google and Microsoft mail and calendar ([OAuth clients](#oauth-clients))  | completes the network's token endpoints only, putting its client on the request   | `integrationFetch` on the token endpoint; the authorize URL from the status's `clientId` | `write` | `clientId` (Mastodon: `origin`) |
| `service`      | `email` ([Gateway services](#gateway-services-email)) | does the work itself: sends the mail from its sender, within its budgets          | `sendEmail({ env, for, message })`, which posts to `/api/integrations/email/send`        | `write` | `sender`, `senders`, `provider` |
| `service`      | `members` ([Gateway services](#gateway-services-members)) | does the work itself: reads its own directory of who can open the app          | `listMembers({ env, for })`, which gets `/api/integrations/members/list`        | `read` |  |

Every status answers `{ capability, requested, configured, ready }`;
`configured` is false for an app that doesn't list the capability, so no app
learns what the operator holds. An AI provider has no status route: an app
lists it in `providers` (and limits it with `ai.models`) and calls
`/api/ai/<provider>/...` with `createGatewayFetch()`, whose refusal
`ai_provider_not_configured` says when its key is unset.

## For an operator

Every key, client and the gateway's own sender live in the gateway Worker's
secrets; an app's senders and inbound addresses are set per installation,
with `everyapp email set` in the app's directory. Set the gateway's from any
directory, as many names at once as you like; the name says it is the
gateway's (an app's own secrets are the names its `everyapp.config.ts` lists
under `secrets`, set from the app's directory or from anywhere with
`--app <id>`):

```bash
pnpm everyapp secret set DATAFORSEO_API_KEY
```

Each value comes from a hidden prompt, or from an environment variable with
`--from-env VAR` (one name). The command changes the live gateway Worker in
one new version and never deploys; every app that lists the capability can
use it from then on. `pnpm everyapp secret list [<app>]` shows which of the
settings an app's manifest needs are set, the gateway's and the app's own. A
capability you skip is simply not offered: its status answers
`configured: false`, and calls `integration_not_configured` (AI:
`ai_provider_not_configured`), naming the command.

Whether an app has what it needs is read from these names, never from a
value. Each provider, capability and secret in a manifest carries a need:
required (the default), optional, or one of a named group. The gateway
shows an app with a required setting unset as "Needs setup" and doesn't
open it; `pnpm everyapp status` lists every app's settings with the one
command to run per app; an optional setting degrades inside the app, where
the feature says what is missing. The model, the manifest fields, every
surface and the rollout are in
[docs/manifest-settings.md](manifest-settings.md).

A coding agent sets each of these up end to end, the provider's side
included, from the everyapp skill's setup files:
[`packages/cli/skills/everyapp/setup/README.md`](../packages/cli/skills/everyapp/setup/README.md)
(one file per integration; copied into every new app's `.claude/skills/everyapp/`).

Everything the gateway holds for apps, in one table:

| What                        | Kind                | Gateway settings                                                                                                           | Set with (`pnpm everyapp secret set …`)                                                          | Used by                                              |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `openai`                    | AI provider         | `OPENAI_API_KEY`                                                                                                           | `OPENAI_API_KEY`                                                                                               | none at launch                                       |
| `openrouter`                | AI provider         | `OPENROUTER_API_KEY`                                                                                                       | `OPENROUTER_API_KEY`                                                                                           | OpenSEO; openmail with `AI_PROVIDER=openrouter` |
| `workers-ai`                | AI provider         | `WORKERS_AI_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID` (which `everyapp setup` sets)                                         | `WORKERS_AI_API_TOKEN` (the Workers AI page's prefilled token: Workers AI Read; a token made by hand needs Workers AI Read and Edit) | openmail with `AI_PROVIDER=workers-ai`          |
| the AI proxy's extra routes | AI provider setting | `AI_PROXY_EXTRA_ROUTES` (optional; OpenAI only, e.g. `/v1/files`)                                                          | `AI_PROXY_EXTRA_ROUTES`                                                                                        |                                                      |
| `dataforseo`                | `api_key`           | `DATAFORSEO_API_KEY` (`login:password`, or its base64)                                                                     | `DATAFORSEO_API_KEY`                                                                                           | OpenSEO                                              |
| `context`                   | `api_key`           | `CONTEXT_API_KEY`                                                                                                          | `CONTEXT_API_KEY`                                                                                              | OpenSEO                                              |
| `email`                     | `service`           | `EMAIL_FROM` and `EMAIL_FROM_NAME` (or `EMAIL_FROM` alone as `Name <address>`), and one provider: Cloudflare Email Sending (the `EMAIL` binding; outside Workers `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) or Resend (`RESEND_API_KEY`); `EMAIL_PROVIDER` picks one when both are set | `EMAIL_FROM EMAIL_FROM_NAME` (or `EMAIL_FROM` alone as `Name <address>`; and `RESEND_API_KEY`, `EMAIL_PROVIDER`), after setting up the sending domain ([runbook](runbooks/email-sending-setup.md)); an app's own senders with `everyapp email set --sender` | openmail, OpenAnalytics, and the gateway's own mail |
| `members`                   | `service`           | none: the gateway reads its own directory                                                                                   | nothing to set                                                                                                 | OpenAnalytics (whom reports go to)                   |
| 16 social networks          | `oauth_client`      | `<NETWORK>_CLIENT_ID`, `<NETWORK>_CLIENT_SECRET` (Meta's networks: `_APP_ID`, `_APP_SECRET`); Mastodon also `MASTODON_URL` | one line per network, generated [below](#oauth-clients)                                                        | OpenCRM (`slack`); the other 15 were added for Postiz's port |
| `google-workspace`, `microsoft-365` | `oauth_client` | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`; `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET` | generated [below](#oauth-clients) | OpenCRM (mail and calendar capture); OpenSEO (Search Console and Analytics) |
| a provider this gateway registered | `api_key` (a row) | its own, each starting with its id (`STRIPE_API_KEY` for `stripe`) | the names `everyapp provider add` prints; `secret set` names the hosts and binds the key to them ([Provider registry](#provider-registry)) | the apps that list it |

X is not in the table: OAuth 1.0a signs every API call with the user's token
secret, which the gateway never holds, so an app keeps `X_API_KEY` and
`X_API_SECRET` as its own secrets (`pnpm everyapp secret set X_API_KEY
X_API_SECRET` in the app's directory, or anywhere with `--app <id>`, after
its first deploy).

### API-key providers

The catalog's, generated from it; a gateway's registered providers are its
own (`pnpm everyapp provider list`):

<!-- api-key-providers:begin (generated from packages/sdk/src/internal/capabilities.ts by capabilitiesDoc.test.ts) -->

| Capability | Provider | Gateway settings | Hosts the key may reach | How the key is sent | Access | Methods |
| --- | --- | --- | --- | --- | --- | --- |
| `dataforseo` | DataForSEO | `DATAFORSEO_API_KEY` | `api.dataforseo.com`, `sandbox.dataforseo.com` | `Authorization: Basic <DATAFORSEO_API_KEY>` (`login:password`, base64-encoded unless it already is) | `read` | GET, POST |
| `context` | Context.dev | `CONTEXT_API_KEY` | `api.context.dev` | `Authorization: Bearer <CONTEXT_API_KEY>` | `read` | GET, POST |
| `stripe` | Stripe | `STRIPE_API_KEY` | `api.stripe.com`, `files.stripe.com` | `Authorization: Bearer <STRIPE_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, DELETE |
| `lemonsqueezy` | Lemon Squeezy | `LEMONSQUEEZY_API_KEY` | `api.lemonsqueezy.com` | `Authorization: Bearer <LEMONSQUEEZY_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PATCH, DELETE |
| `paddle` | Paddle | `PADDLE_API_KEY` | `api.paddle.com`, `sandbox-api.paddle.com` | `Authorization: Bearer <PADDLE_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PATCH, DELETE |
| `shopify` | Shopify | `SHOPIFY_API_TOKEN`, `SHOPIFY_HOST` | the host `<SHOPIFY_HOST>` names | `X-Shopify-Access-Token: <SHOPIFY_API_TOKEN>` | `write` | ; with `access: "write"` also POST |
| `plaid` | Plaid | `PLAID_SECRET` | `sandbox.plaid.com`, `production.plaid.com` | `PLAID-SECRET: <PLAID_SECRET>` | `read` | POST |
| `attio` | Attio | `ATTIO_API_KEY` | `api.attio.com` | `Authorization: Bearer <ATTIO_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `hubspot` | HubSpot | `HUBSPOT_API_TOKEN` | `api.hubapi.com` | `Authorization: Bearer <HUBSPOT_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `pipedrive` | Pipedrive | `PIPEDRIVE_API_TOKEN` | `api.pipedrive.com` | `x-api-token: <PIPEDRIVE_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `airtable` | Airtable | `AIRTABLE_API_TOKEN` | `api.airtable.com` | `Authorization: Bearer <AIRTABLE_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `notion` | Notion | `NOTION_API_TOKEN` | `api.notion.com` | `Authorization: Bearer <NOTION_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PATCH, DELETE |
| `postmark` | Postmark | `POSTMARK_API_TOKEN` | `api.postmarkapp.com` | `X-Postmark-Server-Token: <POSTMARK_API_TOKEN>` | `write` | ; with `access: "write"` also POST |
| `sendgrid` | SendGrid | `SENDGRID_API_KEY` | `api.sendgrid.com`, `api.eu.sendgrid.com` | `Authorization: Bearer <SENDGRID_API_KEY>` | `write` | ; with `access: "write"` also POST |
| `twilio` | Twilio | `TWILIO_API_SECRET`, `TWILIO_API_KEY` | `api.twilio.com` | `Authorization: Basic base64(<TWILIO_API_KEY>:<TWILIO_API_SECRET>)` | `write` | ; with `access: "write"` also POST |
| `intercom` | Intercom | `INTERCOM_API_TOKEN` | `api.intercom.io`, `api.eu.intercom.io`, `api.au.intercom.io` | `Authorization: Bearer <INTERCOM_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `crisp` | Crisp | `CRISP_API_KEY`, `CRISP_API_IDENTIFIER` | `api.crisp.chat` | `Authorization: Basic base64(<CRISP_API_IDENTIFIER>:<CRISP_API_KEY>)` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `linear` | Linear | `LINEAR_API_KEY` | `api.linear.app` | `Authorization: <LINEAR_API_KEY>` | `write` | ; with `access: "write"` also POST |
| `github` | GitHub | `GITHUB_API_TOKEN` | `api.github.com` | `Authorization: Bearer <GITHUB_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `gitlab` | GitLab | `GITLAB_API_TOKEN` | `gitlab.com` | `PRIVATE-TOKEN: <GITLAB_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `vercel` | Vercel | `VERCEL_API_TOKEN` | `api.vercel.com` | `Authorization: Bearer <VERCEL_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `cloudflare` | Cloudflare | `CLOUDFLARE_PROVIDER_API_TOKEN` | `api.cloudflare.com` | `Authorization: Bearer <CLOUDFLARE_PROVIDER_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `posthog` | PostHog | `POSTHOG_PERSONAL_API_KEY` | `us.posthog.com`, `eu.posthog.com` | `Authorization: Bearer <POSTHOG_PERSONAL_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `mixpanel` | Mixpanel | `MIXPANEL_SERVICE_ACCOUNT_SECRET`, `MIXPANEL_SERVICE_ACCOUNT_USERNAME` | `mixpanel.com`, `eu.mixpanel.com`, `in.mixpanel.com`, `data.mixpanel.com`, `data-eu.mixpanel.com`, `data-in.mixpanel.com`, `api.mixpanel.com`, `api-eu.mixpanel.com`, `api-in.mixpanel.com` | `Authorization: Basic base64(<MIXPANEL_SERVICE_ACCOUNT_USERNAME>:<MIXPANEL_SERVICE_ACCOUNT_SECRET>)` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `segment` | Segment | `SEGMENT_WRITE_KEY` | `api.segment.io`, `events.eu1.segmentapis.com` | `Authorization: Basic base64(<SEGMENT_WRITE_KEY>:)` | `write` | ; with `access: "write"` also POST |
| `supabase` | Supabase | `SUPABASE_SECRET_KEY`, `SUPABASE_HOST` | the host `<SUPABASE_HOST>` names | `apikey: <SUPABASE_SECRET_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `turso` | Turso | `TURSO_API_TOKEN` | `api.turso.tech` | `Authorization: Bearer <TURSO_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PATCH, DELETE |
| `turso-db` | Turso database | `TURSO_DB_AUTH_TOKEN`, `TURSO_DB_HOST` | the host `<TURSO_DB_HOST>` names | `Authorization: Bearer <TURSO_DB_AUTH_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST |
| `neon` | Neon | `NEON_API_KEY` | `console.neon.tech` | `Authorization: Bearer <NEON_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `pinecone` | Pinecone | `PINECONE_API_KEY`, `PINECONE_HOST` | `api.pinecone.io`, the host `<PINECONE_HOST>` names | `Api-Key: <PINECONE_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PATCH, DELETE |
| `mapbox` | Mapbox | `MAPBOX_ACCESS_TOKEN` | `api.mapbox.com` | `?access_token=<MAPBOX_ACCESS_TOKEN>` on the URL, in place of the app's own | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
| `openweather` | OpenWeather | `OPENWEATHER_API_KEY` | `api.openweathermap.org`, `pro.openweathermap.org`, `history.openweathermap.org`, `tile.openweathermap.org`, `maps.openweathermap.org` | `?appid=<OPENWEATHER_API_KEY>` on the URL, in place of the app's own | `read` | GET, HEAD |
| `voyage` | Voyage AI | `VOYAGE_API_KEY` | `api.voyageai.com` | `Authorization: Bearer <VOYAGE_API_KEY>` | `read` | POST |
| `perplexity` | Perplexity | `PERPLEXITY_API_KEY` | `api.perplexity.ai` | `Authorization: Bearer <PERPLEXITY_API_KEY>` | `read` | GET, POST |
| `jina` | Jina AI | `JINA_API_KEY` | `api.jina.ai`, `r.jina.ai`, `s.jina.ai` | `Authorization: Bearer <JINA_API_KEY>` | `read` | GET, POST |
| `replicate` | Replicate | `REPLICATE_API_TOKEN` | `api.replicate.com` | `Authorization: Bearer <REPLICATE_API_TOKEN>` | `read` | POST |
| `huggingface` | Hugging Face Inference | `HUGGINGFACE_API_TOKEN` | `router.huggingface.co` | `Authorization: Bearer <HUGGINGFACE_API_TOKEN>` | `read` | GET, POST |
| `firecrawl` | Firecrawl | `FIRECRAWL_API_KEY` | `api.firecrawl.dev` | `Authorization: Bearer <FIRECRAWL_API_KEY>` | `read`, `write` | GET, POST; with `access: "write"` also DELETE |
| `exa` | Exa | `EXA_API_KEY` | `api.exa.ai` | `x-api-key: <EXA_API_KEY>` | `read` | POST |
| `tavily` | Tavily | `TAVILY_API_KEY` | `api.tavily.com` | `Authorization: Bearer <TAVILY_API_KEY>` | `read` | GET, POST |
| `serper` | Serper | `SERPER_API_KEY` | `google.serper.dev`, `scrape.serper.dev` | `X-API-KEY: <SERPER_API_KEY>` | `read` | POST |
| `brave-search` | Brave Search | `BRAVE_SEARCH_API_KEY` | `api.search.brave.com` | `X-Subscription-Token: <BRAVE_SEARCH_API_KEY>` | `read` | GET, POST |
| `apify` | Apify | `APIFY_API_TOKEN` | `api.apify.com` | `Authorization: Bearer <APIFY_API_TOKEN>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, DELETE |
| `deepgram` | Deepgram | `DEEPGRAM_API_KEY` | `api.deepgram.com`, `api.eu.deepgram.com`, `api.au.deepgram.com`, `api.in.deepgram.com` | `Authorization: Token <DEEPGRAM_API_KEY>` | `read` | GET, POST |
| `elevenlabs` | ElevenLabs | `ELEVENLABS_API_KEY` | `api.elevenlabs.io` | `xi-api-key: <ELEVENLABS_API_KEY>` | `read` | GET, POST |
| `assemblyai` | AssemblyAI | `ASSEMBLYAI_API_KEY` | `api.assemblyai.com`, `api.eu.assemblyai.com` | `Authorization: <ASSEMBLYAI_API_KEY>` | `read`, `write` | GET, POST; with `access: "write"` also DELETE |
| `newsapi` | NewsAPI | `NEWSAPI_API_KEY` | `newsapi.org` | `X-Api-Key: <NEWSAPI_API_KEY>` | `read` | GET |

<!-- api-key-providers:end -->

DataForSEO can also go to members' AI clients directly, with nothing
deployed: `pnpm everyapp mcp on dataforseo` ([MCP apps](#mcp-apps)).

### AI providers

An app lists the provider in its manifest's `providers` and calls
`/api/ai/<provider>/...` with `createGatewayFetch()`; `ai.models` limits the
models it may ask for.

| AI provider  | Gateway setting                                  | Upstream                                             | Routes apps may call                                      |
| ------------ | ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| `openai`     | `OPENAI_API_KEY`                                 | `api.openai.com`                                     | inference, plus what `AI_PROXY_EXTRA_ROUTES` allows       |
| `openrouter` | `OPENROUTER_API_KEY`                             | `openrouter.ai`                                      | inference                                                 |
| `workers-ai` | `WORKERS_AI_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `api.cloudflare.com/client/v4/accounts/<account>/ai` | `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses` |

Workers AI runs in the gateway's own account (`CLOUDFLARE_ACCOUNT_ID`, which
`everyapp setup` sets) with an API token from the dashboard's Workers AI
page, **Use REST API** → **Create a Workers AI API Token**. The prefilled
token grants Workers AI Read, which is what every
`/accounts/<account>/ai/*` call needs; a token made by hand needs Workers
AI Read and Edit (Cloudflare's REST guide):

```bash
pnpm everyapp secret set WORKERS_AI_API_TOKEN
```

Apps reach its OpenAI-compatible API, never the native `/ai/run/<model>`, so
an OpenAI client works unchanged with `baseURL`
`http://every-app-gateway.internal/api/ai/workers-ai/v1` and models such as
`@cf/meta/llama-4-scout-17b-16e-instruct`. Meta's models send a token made
only of digits as a JSON number (`"content":18`), which OpenAI clients
refuse; the gateway turns those back into strings in chat completions.
Without the token or the account, calls answer 503
`ai_provider_not_configured`.

Workers AI never runs locally, and it is billed: with no gateway in
`everyapp dev`, an app calls it with `WORKERS_AI_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in its `.dev.vars` (the developer's own token and
account; the SDK applies the same fix to the stream), or switches to
another provider (an `AI_PROVIDER=openrouter` setting of the app's own).

The AI proxy's refusals carry the `x-everyapp-error` header and OpenAI's
error body, `{ "error": { "message", "code", "type": "gateway_refusal" } }`,
so OpenAI SDKs and ai-sdk show the message: `provider_not_allowed`,
`ai_provider_not_supported`, `ai_provider_not_configured`,
`ai_request_invalid`, `ai_route_not_allowed`, `model_not_allowed` and
`ai_upstream_failed`.

## For an app

List it in `everyapp.config.ts`:

```ts
capabilities: {
  dataforseo: {
    access: "read",
    why: "Keyword and SERP data for rank tracking.",
  },
},
```

`everyapp deploy` refuses a capability neither the catalog nor the
gateway's registered providers have (`CAPABILITY_UNKNOWN`, naming
`pnpm everyapp provider add`), an AI provider listed here instead of under
`providers`, and an access level the provider doesn't offer (`write`, for
both catalog API-key providers today; `read`, for email and the OAuth
clients). `everyapp dev` can't ask the gateway, so it accepts an id outside
the catalog and warns `CAPABILITY_NOT_IN_CATALOG`.

An entry may also say its need: `optional: true` when only one feature uses
it (the app opens without it, and that feature says what is missing),
`anyOf: "<group>"` when any one of several is enough, `why` for whoever
sets it, and `docs` to replace the registry's default page. Without them
the capability is required, and the app doesn't open until it is set
([docs/manifest-settings.md](manifest-settings.md)).

Call the provider's real URLs with the SDK's fetch:

```ts
import {
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
} from "@every-app/sdk/server";

const dataforseo = integrationFetch({
  env,
  provider: "dataforseo",
});
const response = await dataforseo(
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
  {
    method: "POST",
    body: JSON.stringify([{ keyword: "seo tools", location_code: 2840 }]),
  },
);
// The gateway's own refusals, as opposed to DataForSEO's errors:
const refused = await gatewayRefusal(response);

// Show "the gateway's operator needs to set up DataForSEO" before a task fails:
const { ready } = await integrationStatus({ env, provider: "dataforseo" });
```

- Approval is of the app: listing the capability is the grant, for every
  call the app makes. A call made while `everyApp()` serves a request is
  attributed to the request's user (the SDK's request context; `for:
  request` says it explicitly); background work (crons, Workflows,
  queues) runs under `withOrganization(organizationId, fn)`, and an
  organization's own app may pass `for: { background: true }` to make the
  call the app's. A shared app's Worker serves every organization, so its
  background work names one, sent as `x-everyapp-org`;
  the gateway accepts it for an active organization with a live member and
  attributes the call to that organization. A shared Worker's call that
  names neither throws `AttributionError`.
- In local dev (`everyapp dev`, no binding) the fetch calls the provider
  directly with the developer's own key from `.dev.vars`, under the same
  name as the gateway secret.

## What the gateway checks on an API-key call

`AppGateway` serves `/api/integrations/<capability>/<host>/<path>` over the
app's private binding (`handleIntegrationProxyRequest` in
`apps/every-app-gateway/src/server/integration-proxy.ts`), with the
provider looked up in the gateway's registry (the catalog, then its
registered rows). The checks run in this order, the code's:

1. The caller is a registered, active app: the AppGateway entrypoint checks
   the binding's props against the app's registry row before the proxy
   runs, as for AI (`missing_caller_identity` 401, `caller_not_registered`
   403, ...).
2. The route: the id is an API-key provider of the registry (an AI
   provider's id, or an id nobody has, is refused here), the host is one of
   its hosts or the one its `hostSetting` names, over https, with no path
   that could leave it; otherwise `invalid_integration_route` (400).
3. The grant: the app's registry row's manifest lists the capability;
   otherwise `capability_not_requested` (403).
4. The account-wide paths: the path isn't one the entry lists as describing
   the whole provider account (DataForSEO's `tasks_ready`, `tasks_fixed`,
   `id_list`, `errors`, `appendix/user_data`, `appendix/webhook_resend`),
   however spelled, since one key serves every app in every organization;
   otherwise `integration_path_not_allowed` (403).
5. The method and the write grant: a method in the entry's `readMethods`
   goes through on any grant; a method in its `writeMethods` only when the
   provider offers `write` and the app's entry asks for `access: "write"`;
   otherwise `integration_method_not_allowed` (405), whose message says
   whether `access: "write"` would allow it.
6. The key and its binding: every setting the entry's `auth` names is set;
   otherwise `integration_not_configured` (503), whose message names the
   settings and the `everyapp secret set` that sets them. For a registered
   provider the key must also be bound to the hosts and auth the row has
   now ([Provider registry](#provider-registry)); otherwise
   `integration_not_configured` (503), "the key was set for other hosts
   than the provider has now", with the same command.
7. The hosted rule: on a hosted gateway, a provider whose `data` is
   `account` (every list is the whole account the key belongs to) is
   refused, `integration_not_available_hosted` (503), since one key would
   be every organization's; a self-hosted gateway serves it.
8. Attribution and the cap: the call is attributed to an organization (the
   AppGateway entrypoint's `caller_*` refusals) and refused at the
   organization's monthly cap on the app, `app_monthly_cap_exceeded` (429),
   before anything is sent.
9. The agent's write scope: a write method under an agent's identity
   (`chan: "mcp"`) without `mcp:write` is `integration_read_only` (403).

It then drops the app's `Authorization`, `x-api-key`, cookies, every
`x-everyapp-*` header and the hop-by-hop and forwarding headers, puts the
key where the entry's `auth` says (a header, or a query parameter that
replaces every copy the app sent), refuses to follow redirects, and streams
the body both ways without the provider's `set-cookie`. A provider it cannot
reach is `integration_upstream_failed` (502). For a provider whose key goes
in the query string the key is in the URL, so the answer's `location`,
`content-location` and `refresh` headers are deleted, a 3xx answer is never
relayed (`integration_upstream_redirected`, 502), and a failed call logs the
error's name only, never a message that might quote the URL. The call is
counted the moment the provider answers. Every call is logged
(`integration.proxy.call`) with the organization, app, host, path, method,
status and attribution, and with the call's cost where the entry names a
`cost.responseField`: a top-level field of the answer read off its first
2 KiB, in US dollars, added to the usage counters (DataForSEO's `cost`; no
other provider's answer is read). Refusals the gateway makes, the
AppGateway entrypoint's own included (`caller_not_registered`,
`invalid_gateway_route`, ...), carry their code in `x-everyapp-error` so an
app can tell them from the provider's own errors.

`GET /api/integrations/<capability>` answers
`{ capability, requested, configured, ready }` without calling the provider
(`integrationStatus`); `configured` is false for an app that doesn't list the
capability, so no app learns which keys the operator holds.

## Provider registry

An API-key provider the catalog doesn't have can be registered on one
gateway: `pnpm everyapp provider add stripe.json` writes a row of the
gateway's `providers` table (migration 0010) holding a JSON spec of the
same shape as a catalog entry (hosts, the `auth` that says where the key
goes, the settings it names, the methods, the account-wide paths). The
gateway resolves the catalog first and its rows after
(`providerRegistry()` in `packages/sdk/src/internal/providerRegistry.ts`,
read by `apps/every-app-gateway/src/server/providers/index.ts` and cached
30 seconds per isolate), so an app lists and calls a registered provider
exactly as a catalog one, and every check above applies to it. What a row
may say is the security boundary: its settings carry its own id as a prefix
and are nobody else's, its hosts are public DNS names the gateway doesn't
serve itself, it never shadows a catalog id, and its key is read only for
the hosts and auth it was set for (`secret set` binds it; a replaced row
needs the key again). The gateway checks every row again each time it
reads one and leaves out, logged `provider.row_invalid`, a row that fails.
`pnpm everyapp provider list` lists the catalog and the rows with whether
each setting is set and bound; `provider show <id>` prints a spec;
`provider remove <id>` removes a row. The spec's fields, the auth kinds,
the rules, the commands and their codes are the agent docs page
[/docs/agent/providers](https://everyapp.com/docs/agent/providers); the
rules' invariants are the `providers.*` rows of the threat model's register
(B4), and the design is docs/design/2026-10-provider-registry.md.

## OAuth clients

Since 2026-10-25 an OAuth client can also run the Gateway-owned flow (`docs/design/2026-10-oauth-providers.md`): the catalog's `google-workspace`, `microsoft-365`, `slack` and `discord` carry a `flow` block, and any OAuth provider added from a preset or a spec with `auth.kind: "oauth2-user"` (`everyapp provider add --oauth github-oauth`) is one. There the person connects at `https://<gateway>/connect/<id>` (PKCE, a one-use state), the Gateway holds the tokens sealed in D1 and refreshes them, and an app that lists the provider with `scopes` calls its API hosts through `integrationFetch()` with the token put on by the Gateway, held to the sets it declared. The client may be the Worker secrets below or one pasted in Manage workspace → Providers (sealed in `oauth_clients`; the Worker secret wins). The redirect URI for that flow is `https://<gateway>/connect/<id>/callback`. The app-driven flow below is unchanged and both run on the same client; the agent page is [providers](../landing-page/content/agent/providers.md).

A social network's OAuth client is a capability too (`oauth_client`): the
operator registers one client per network on the network's developer
console and gives it to the gateway, and every app that lists the network
connects people's accounts with it. The gateway completes the network's
**token endpoints only**, and only a user's own grants (`authorization_code`,
`refresh_token` and the network's token exchanges; `client_credentials`, which
would mint a token for the operator's own application, is refused), putting
its client on the request; the app builds
the authorize URL from the client's public id, keeps the access and refresh
tokens it gets back, and calls the network's API with them itself. The
client secret never reaches an app. OpenCRM uses `slack` (and the two
clients below) at launch; the social networks were added for Postiz, which
is ported but not part of the launch.

Two clients serve mail and calendar rather than a social network:
`google-workspace` (Gmail, Google Calendar, Search Console and Google
Analytics, read-only) and `microsoft-365` (Outlook mail and calendar through
Microsoft Graph, read-only). OpenCRM
reads each member's own mailbox and calendar with them. Gmail's read scope is
one of Google's restricted scopes: an *Internal* consent screen (every
mailbox in the operator's Workspace) needs no review, while an *External*
one needs Google's verification and a yearly security assessment before
other people's mailboxes can connect. Register the Microsoft client for
accounts in any organization and personal accounts: the gateway completes
the `common` token endpoint only.

**For an operator.** For each network you want people to connect: register
an app on its developer console, register the redirect URIs below (on the
app's host, `https://<app>.<APP_BASE_DOMAIN>`), allow the scopes listed
further down, then hand the client to the gateway:

```bash
pnpm everyapp secret set LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET
```

A network you skip is simply not offered: its status answers
`configured: false`. Mastodon's client lives on one instance:
`MASTODON_URL` names it (`https://mastodon.social` when unset), and the
token endpoint, the authorize page and the API are on it. One client per
network serves every organization on the gateway, so a network's limits
(Meta's app review tiers, TikTok's user caps, Google's refresh tokens per
user) are shared too. X is not here (OAuth 1.0a signs every API call with
the user's token secret, which the gateway never holds): an app keeps
`X_API_KEY`/`X_API_SECRET` as its own secrets.

**For an app.** List each network for writing (obtaining and refreshing
tokens with the operator's client writes). A client with scope sets
(`slack`, `google-workspace`, `microsoft-365`; the table at the end of this section)
requires `scopes`, one or more set names, each once: the validator refuses
the entry without them, or with a name the client doesn't offer, naming the
sets it does, and refuses `scopes` on a client without any.

```ts
capabilities: {
  linkedin: { access: "write", why: "Connects LinkedIn profiles and pages." },
  mastodon: { access: "write" },
  "google-workspace": {
    access: "write",
    scopes: ["gmail.read", "calendar.read"],
    why: "Reads each member's own mailbox and calendar.",
  },
},
```

then build the authorize URL from the status, and exchange the code (or
refresh a token) through the gateway without any client:

```ts
import { integrationFetch, integrationStatus } from "@every-app/sdk/server";

const { ready, clientId } = await integrationStatus({ env, provider: "linkedin" });
if (!ready) return showNotSetUp("LinkedIn");
const authorize = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=...`;

// The callback: the gateway adds client_id and client_secret.
const linkedin = integrationFetch({ env, provider: "linkedin" });
const tokens = await linkedin("https://www.linkedin.com/oauth/v2/accessToken", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
});
// A refresh from a cron or Workflow runs under withOrganization(organizationId, fn).
```

Mastodon's status also carries `origin` (the instance). Twitch wants the
public id as `Client-Id` on its API calls too: it is the status's
`clientId`. In local dev (`everyapp dev`, no binding) the fetch calls the
token endpoint directly and puts the developer's own client from
`.dev.vars`, under the same names, on it by the same rule.

**What the gateway checks**, in order, each a refusal with its code in
`x-everyapp-error`:

| Code                            | Status  | When                                                                                          |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `integration_not_configured`    | 503     | `MASTODON_URL` is set but isn't an https origin                                               |
| `integration_path_not_allowed`  | 403     | the call isn't one of the network's token endpoints (host, exact path, method): API calls go to the network directly |
| `capability_not_requested`      | 403     | the deployed manifest doesn't list the network with `access: "write"`                         |
| `integration_scopes_undeclared` | 403     | the network has scope sets and the entry's `scopes` isn't a non-empty list of names this gateway offers (missing, empty, a duplicate or an unknown name voids the whole grant); the message names the sets on offer |
| `caller_*`                      | 401/403 | the AppGateway entrypoint's attribution (a shared app's Worker names the organization)        |
| `integration_agent_not_allowed` | 403     | an agent's identity (`chan: "mcp"`), with or without `mcp:write`: agents can't connect accounts or mint tokens |
| `integration_grant_not_allowed` | 403     | the `grant_type` isn't a user's grant, or isn't one this client's scope policy completes (`client_credentials` and token exchanges would mint a token for the operator's own application; on Google and Microsoft a request without `grant_type` too) |
| `integration_not_configured`    | 503     | the gateway doesn't hold the client; the message names the `secret set` command               |
| `integration_body_too_large`    | 413     | the body passes 64 KiB, counted as it streams                                                 |
| `integration_body_invalid`      | 400     | the body isn't form-encoded or JSON, or not the one the endpoint takes; with scope sets, also a `grant_type`, `scope` or `user_scope` in the query string, or `grant_type` more than once in a form body: the gateway decides on the body, once |
| `integration_scope_not_allowed` | 403     | with scope sets, the request's `scope` (Slack: `user_scope`) names a scope outside the app's sets |
| `integration_upstream_failed`   | 502     | the network couldn't be reached, or (with scope sets) its 2xx answer broke off while the gateway read it; nothing was passed on |
| `integration_response_invalid`  | 502     | with scope sets, a 2xx answer over 64 KiB or not a JSON object; nothing was passed on         |
| `integration_scope_unverified`  | 502     | with scope sets, a 2xx answer carrying a token without saying which scopes it holds; nothing was passed on |
| `integration_scope_exceeded`    | 403     | with scope sets, the granted scopes go beyond the app's sets (a wider earlier consent, `include_granted_scopes`, a refresh after a set was removed); the tokens are dropped, never forwarded, stored, logged or revoked, and the message says how the person reconnects |

It then drops the app's `Authorization`, cookies and every `x-everyapp-*`
header, removes any `client_id` or `client_secret` the app put in the query
string or the body (in any case, under the endpoint's own names too), puts
the gateway's client where the endpoint takes it (`form`: the form body;
`basic`: HTTP Basic; `query`: the query string; `json`: the JSON body),
re-serialises the body, refuses to follow redirects, drops the network's
`set-cookie`, and streams the answer back. For a network with scope sets it
also sets the request's `scope` as the network takes it (Microsoft: the
app's list, so a token covers Graph alone; Google: dropped), reads a 2xx
answer under the same 64 KiB cap and holds what the network says it granted
to the app's sets before passing the buffered answer on; a non-2xx answer
streams through as it came. Each call is logged
(`integration.proxy.call`) with the organization, app, host, path, method,
the request's `grant_type`, status and attribution (with scope sets, the
declared set names); never the query, the body or the answer, which carry
the client, codes and tokens, except the declared set names and the scope
names in excess when it refuses one (`integration.proxy.scope_refused`).

`GET /api/integrations/<network>` answers
`{ capability, requested, configured, ready, clientId?, origin?, scopeSets?, scopes?, userScopes? }`;
`clientId` (and Mastodon's `origin`) only for an app that lists the network,
once the gateway holds its client. For a network with scope sets,
`scopeSets` (the names the app's entry lists) and `scopes` (the exact
provider strings to put on the authorize URL, in registry order;
Microsoft's end with `offline_access`; Slack's user scopes come under
`userScopes`), answered for a valid grant whether or not the gateway holds
the client (without one: `configured: false`, `ready: false`, no
`clientId`); a void grant answers `ready: false` and `scopeSets: []` with
no `clientId` and no `scopes`, so the app shows "not available" instead of
starting a flow the gateway would refuse to complete. A dispatched app's
Worker can't reach the token endpoints directly either: the outbound Worker
refuses them (`reserved_endpoint`), though not the networks' API hosts.

<!-- oauth-clients:begin (generated from packages/sdk/src/internal/capabilities.ts by capabilitiesDoc.test.ts) -->

| Capability | Network | Gateway secrets | Developer console | Redirect URIs to register | Token endpoints the gateway completes (where the client goes) |
| --- | --- | --- | --- | --- | --- |
| `linkedin` | LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | https://www.linkedin.com/developers/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/linkedin`, `https://<app>.<APP_BASE_DOMAIN>/integrations/social/linkedin-page` | POST `www.linkedin.com/oauth/v2/accessToken` (form) |
| `facebook` | Facebook | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | https://developers.facebook.com/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/facebook`, `https://<app>.<APP_BASE_DOMAIN>/integrations/social/instagram` | GET/POST `graph.facebook.com/v<version>/oauth/access_token` (query) |
| `instagram` | Instagram | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | https://developers.facebook.com/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/instagram-standalone` | POST `api.instagram.com/oauth/access_token` (form); GET `graph.instagram.com/access_token` (query) |
| `threads` | Threads | `THREADS_APP_ID`, `THREADS_APP_SECRET` | https://developers.facebook.com/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/threads` | GET/POST `graph.threads.net/oauth/access_token` (query); GET `graph.threads.net/access_token` (query) |
| `youtube` | YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | https://console.cloud.google.com/apis/credentials | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/youtube`, `https://<app>.<APP_BASE_DOMAIN>/integrations/social/gmb` | POST `oauth2.googleapis.com/token` (form) |
| `tiktok` | TikTok | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` | https://developers.tiktok.com/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/tiktok` | POST `open.tiktokapis.com/v2/oauth/token/` (form, id as `client_key`) |
| `tiktok-business` | TikTok Business | `TIKTOK_BUSINESS_CLIENT_ID`, `TIKTOK_BUSINESS_CLIENT_SECRET` | https://business-api.tiktok.com/portal/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/tiktok-business/` | POST `business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/` (json); POST `business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/` (json) |
| `reddit` | Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | https://www.reddit.com/prefs/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/reddit` | POST `www.reddit.com/api/v1/access_token` (basic) |
| `pinterest` | Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | https://developers.pinterest.com/apps/ | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/pinterest` | POST `api.pinterest.com/v5/oauth/token` (basic) |
| `discord` | Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | https://discord.com/developers/applications | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/discord` | POST `discord.com/api/oauth2/token` (basic) |
| `slack` | Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | https://api.slack.com/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/slack`, `https://<app>.<APP_BASE_DOMAIN>/integrations/slack/callback` | POST `slack.com/api/oauth.v2.access` (form) |
| `mastodon` | Mastodon | `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET`, `MASTODON_URL` | `<MASTODON_URL>/settings/applications` | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/mastodon` | POST `<MASTODON_URL>/oauth/token` (form) |
| `kick` | Kick | `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | https://kick.com/settings/developer | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/kick` | POST `id.kick.com/oauth/token` (form) |
| `twitch` | Twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | https://dev.twitch.tv/console/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/twitch` | POST `id.twitch.tv/oauth2/token` (form) |
| `tumblr` | Tumblr | `TUMBLR_CLIENT_ID`, `TUMBLR_CLIENT_SECRET` | https://www.tumblr.com/oauth/apps | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/tumblr` | POST `api.tumblr.com/v2/oauth2/token` (form) |
| `dribbble` | Dribbble | `DRIBBBLE_CLIENT_ID`, `DRIBBBLE_CLIENT_SECRET` | https://dribbble.com/account/applications | `https://<app>.<APP_BASE_DOMAIN>/integrations/social/dribbble` | POST `dribbble.com/oauth/token` (query) |
| `google-workspace` | Google (Gmail, Calendar, Search Console and Analytics) | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET` | https://console.cloud.google.com/apis/credentials | `https://<app>.<APP_BASE_DOMAIN>/integrations/google/callback` | POST `oauth2.googleapis.com/token` (form) |
| `microsoft-365` | Microsoft 365 (Outlook mail and calendar) | `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET` | https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade | `https://<app>.<APP_BASE_DOMAIN>/integrations/microsoft/callback` | POST `login.microsoftonline.com/common/oauth2/v2.0/token` (form) |

The commands, one per network you offer (each prompts for the values):

```bash
pnpm everyapp secret set LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET
pnpm everyapp secret set FACEBOOK_APP_ID FACEBOOK_APP_SECRET
pnpm everyapp secret set INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET
pnpm everyapp secret set THREADS_APP_ID THREADS_APP_SECRET
pnpm everyapp secret set YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET
pnpm everyapp secret set TIKTOK_CLIENT_ID TIKTOK_CLIENT_SECRET
pnpm everyapp secret set TIKTOK_BUSINESS_CLIENT_ID TIKTOK_BUSINESS_CLIENT_SECRET
pnpm everyapp secret set REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET
pnpm everyapp secret set PINTEREST_CLIENT_ID PINTEREST_CLIENT_SECRET
pnpm everyapp secret set DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET
pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET
pnpm everyapp secret set MASTODON_CLIENT_ID MASTODON_CLIENT_SECRET MASTODON_URL
pnpm everyapp secret set KICK_CLIENT_ID KICK_CLIENT_SECRET
pnpm everyapp secret set TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET
pnpm everyapp secret set TUMBLR_CLIENT_ID TUMBLR_CLIENT_SECRET
pnpm everyapp secret set DRIBBBLE_CLIENT_ID DRIBBBLE_CLIENT_SECRET
pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET
pnpm everyapp secret set MICROSOFT_365_CLIENT_ID MICROSOFT_365_CLIENT_SECRET
```

The authorize page each client sends people to, and the scopes the operator allows on the client; an app lists the scope sets it uses:

| Capability | Authorize URL | Scopes |
| --- | --- | --- |
| `linkedin` | `https://www.linkedin.com/oauth/v2/authorization` | `openid`, `profile`, `w_member_social`, `r_basicprofile`, `rw_organization_admin`, `w_organization_social`, `r_organization_social` |
| `facebook` | `https://www.facebook.com/v25.0/dialog/oauth` | `pages_show_list`, `business_management`, `pages_manage_posts`, `pages_manage_engagement`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights` |
| `instagram` | `https://www.instagram.com/oauth/authorize` | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights` |
| `threads` | `https://threads.net/oauth/authorize` | `threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_manage_insights` |
| `youtube` | `https://accounts.google.com/o/oauth2/v2/auth` | `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/youtube`, `https://www.googleapis.com/auth/youtube.force-ssl`, `https://www.googleapis.com/auth/youtube.readonly`, `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtubepartner`, `https://www.googleapis.com/auth/yt-analytics.readonly`, `https://www.googleapis.com/auth/business.manage` |
| `tiktok` | `https://www.tiktok.com/v2/auth/authorize/` | `video.list`, `user.info.basic`, `video.publish`, `video.upload`, `user.info.profile`, `user.info.stats` |
| `tiktok-business` | `https://www.tiktok.com/v2/auth/authorize/` | `user.info.basic`, `user.info.username`, `user.info.stats`, `video.list`, `video.upload`, `video.publish` |
| `reddit` | `https://www.reddit.com/api/v1/authorize` | `read`, `identity`, `submit`, `flair` |
| `pinterest` | `https://www.pinterest.com/oauth/` | `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read` |
| `discord` | `https://discord.com/oauth2/authorize` | `bot`, `identify`, `guilds` |
| `slack` | `https://slack.com/oauth/v2/authorize` | `channels:read`, `groups:read`, `users:read`, `users:read.email`, `chat:write`, `chat:write.public`, `chat:write.customize`, `channels:join`, `channels:manage`, `groups:write`, `channels:write.invites`, `groups:write.invites`, `im:write`, `files:write`, `channels:write` |
| `mastodon` | `<MASTODON_URL>/oauth/authorize` | `write:statuses`, `profile`, `write:media` |
| `kick` | `https://id.kick.com/oauth/authorize` | `chat:write`, `user:read`, `channel:read` |
| `twitch` | `https://id.twitch.tv/oauth2/authorize` | `user:write:chat`, `user:read:chat`, `moderator:manage:announcements` |
| `tumblr` | `https://www.tumblr.com/oauth2/authorize` | `write`, `offline_access` |
| `dribbble` | `https://dribbble.com/oauth/authorize` | `public`, `upload` |
| `google-workspace` | `https://accounts.google.com/o/oauth2/v2/auth` | `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/webmasters.readonly`, `https://www.googleapis.com/auth/analytics.readonly` |
| `microsoft-365` | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` | `offline_access`, `User.Read`, `Mail.Read`, `Calendars.Read` |

Scope sets an app may list (`scopes` on its capability entry), each with the provider scopes it asks for; a client with none takes the whole client as the grant:

| Capability | Scope set | Label | Access | Provider scopes |
| --- | --- | --- | --- | --- |
| `slack` | `channels.read` | Channels (read-only) | read | `channels:read`, `groups:read` |
| `slack` | `users.read` | Members (read-only) | read | `users:read` |
| `slack` | `users.email` | Members' email addresses (read-only) | read | `users:read.email` |
| `slack` | `messages.write` | Messages (post as the app) | write | `chat:write`, `chat:write.public`, `chat:write.customize` |
| `slack` | `channels.join` | Channels (join public ones) | write | `channels:join` |
| `slack` | `channels.manage` | Channels (create, manage and invite to; open DMs) | write | `channels:manage`, `groups:write`, `channels:write.invites`, `groups:write.invites`, `im:write` |
| `slack` | `files.write` | Files (upload) | write | `files:write` |
| `slack` | `user-channels.manage` | Channels (as the installing person: read, manage, invite to) | write | `channels:read` (user token), `channels:write` (user token), `groups:read` (user token), `groups:write` (user token) |
| `google-workspace` | `identity` | Google account (who you are) | read | `openid`, `email`, `profile` |
| `google-workspace` | `gmail.read` | Gmail (read-only) | read | `https://www.googleapis.com/auth/gmail.readonly` |
| `google-workspace` | `calendar.read` | Google Calendar (read-only) | read | `https://www.googleapis.com/auth/calendar.readonly` |
| `google-workspace` | `search-console.read` | Search Console (read-only) | read | `https://www.googleapis.com/auth/webmasters.readonly` |
| `google-workspace` | `analytics.read` | Google Analytics (read-only) | read | `https://www.googleapis.com/auth/analytics.readonly` |
| `microsoft-365` | `identity` | Microsoft account (who you are) | read | `User.Read` |
| `microsoft-365` | `mail.read` | Outlook mail (read-only) | read | `Mail.Read` |
| `microsoft-365` | `calendar.read` | Outlook calendar (read-only) | read | `Calendars.Read` |

<!-- oauth-clients:end -->

## Gateway services: email

`email` is a capability the gateway performs itself: apps send mail through
the gateway's own sender and provider, within its daily budgets. The
provider is the operator's, one per gateway: Cloudflare Email Sending (its
`EMAIL` binding, or the REST API on a gateway outside Workers) or Resend.
One sending domain set up per gateway serves every app, and every message
is attributed and logged. Apps get no `send-email` binding (the deploy
refuses one); they call `sendEmail()`.

| Capability | Gateway settings                                                                   | Route                               | Access  |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------- | ------- |
| `email`    | `EMAIL_FROM` and `EMAIL_FROM_NAME` (or `EMAIL_FROM` alone as `Name <address>`); Cloudflare: the `EMAIL` binding, or `EMAIL_REST_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`; Resend: `RESEND_API_KEY`; `EMAIL_PROVIDER` (`cloudflare` or `resend`) when both are set | `POST /api/integrations/email/send` | `write` |

Without `EMAIL_PROVIDER` the gateway picks Cloudflare when its REST pair is
set, else Resend when `RESEND_API_KEY` is, else Cloudflare's `EMAIL`
binding; an `EMAIL_PROVIDER` that isn't a provider, or isn't set up,
leaves the gateway unable to send.

The operator's side is the email runbook
([docs/runbooks/email-sending-setup.md](runbooks/email-sending-setup.md)):
set up the gateway's sending domain with its provider, then set the sender.
The gateway's own invitation and password-reset mail uses the same setup
and the same provider.

An app lists it:

```ts
capabilities: {
  email: {
    access: "write",
    why: "Sends replies from the organization's mailboxes.",
  },
},
```

The addresses it may send as are its installation's, not the manifest's:
`pnpm everyapp email set --sender "*@mail.example.com"` in the app's
directory, after its first deploy. Without any, mail goes out as the
gateway's sender only. It sends:

```ts
import { GatewayRefusalError, sendEmail } from "@every-app/sdk/server";

try {
  const { messageId, status } = await sendEmail({
    env, // whose: the request being served, or withOrganization()'s organization
    message: {
      to: "customer@example.net",
      subject: "Your order shipped",
      text: "It's on its way.",
      from: { address: "orders@mail.example.com", name: "Acme" },
    },
  });
} catch (error) {
  if (error instanceof GatewayRefusalError) {
    // error.code: email_sender_not_allowed, email_budget_exhausted, ...
  }
  throw error;
}
```

**The message** (`POST /api/integrations/email/send`, JSON, at most 5 MiB
as sent, attachments included):

| Field         | Type                                                                                 | Rule                                                              |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `to`          | address or list                                                                      | at least one; 50 recipients at most across `to`, `cc` and `bcc`   |
| `cc`, `bcc`   | address or list                                                                      | plain addresses (no display names)                                |
| `subject`     | string                                                                               | one line, 998 characters at most                                  |
| `text`, `html`| string                                                                               | at least one                                                      |
| `from`        | address or `{ address, name? }`                                                      | absent: the gateway's sender; present: must match one of the installation's senders |
| `replyTo`     | address or `{ address, name? }`                                                      | absent: replies go to the sender                                  |
| `headers`     | `{ name: value }`                                                                    | 20 at most, values one line of 2,048 bytes at most; `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Sender`, `Return-Path`, `Date`, MIME and DKIM headers are refused (the message's own fields set them) |
| `attachments` | `[{ filename, contentType, content (base64), disposition?: "attachment" \| "inline", contentId? }]` | 32 at most; an inline one needs a `contentId` (`cid:` in the HTML) |

Unknown fields are refused. The answer is `200 { messageId?, status }`:
`delivered` (the provider accepted it) or `queued` (Cloudflare's REST
transport will retry some recipients). In local dev the SDK answers
`logged` (below).

**The sender rule.** Without `from`, the message goes out as `EMAIL_FROM`
with its display name, `EMAIL_FROM_NAME` or the name in
`EMAIL_FROM="Name <address>"`; a bare address with no name is not a
configured sender, and the gateway sends nothing. With one, the address
must match one of the
installation's senders, set with `everyapp email set --sender` and stored
on the app's registry row (never in the manifest, so a release carries
none): `*@<domain>` takes any address on exactly that domain (not its
subdomains), anything else that one address; patterns are lowercase,
unique, 20 at most, and the command checks them. A change applies within
30 seconds (the gateway caches the app's row that long). Each domain an app
sends from must also be set up with the gateway's provider, onboarded to
Email Sending in the gateway's Cloudflare account (on Cloudflare DNS) or
verified in its Resend account, or the provider refuses it:
`email_sender_not_verified`, whose message names the step. A hosted gateway
sends app mail from its own sender only, for now: any `from` is refused,
and `everyapp email set --sender` refuses on a hosted install.

**Budgets.** App mail (`app` kind) counts against daily budgets in
`rate_limit_counters`, once for each distinct recipient, before it is sent:
100 per recipient address and 5,000 for the whole gateway a day when
self-hosted, 20 and 5,000 when hosted, none when the mode is invalid. There
is no per-organization mail budget (the monthly cap under Manage workspace →
Usage counts provider calls, not mail). A message
any of whose recipients has had its share is refused whole, with
`Retry-After` until the next UTC midnight.

**Checks, in order**, each a refusal with its code in `x-everyapp-error`:

| Code                             | Status | When                                                                                         |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `integration_method_not_allowed` | 405    | anything but `POST` on `send`                                                                |
| `capability_not_requested`       | 403    | the manifest doesn't list `email` with `access: "write"`                                     |
| `caller_*`                       | 401/403 | the AppGateway entrypoint's attribution (a shared app's Worker names the organization)      |
| `integration_read_only`          | 403    | an agent's identity (`chan: "mcp"`) without `mcp:write`                                      |
| `email_message_too_large`        | 413    | the body passes 5 MiB, counted as it streams                                                 |
| `email_invalid_message`          | 400    | the message breaks a rule above, or the provider refuses it as malformed (Resend: other 400s and 422s) |
| `email_sender_not_allowed`       | 403    | `from` matches none of the installation's senders, or the gateway is hosted                  |
| `integration_not_configured`     | 503    | the gateway has no sender or provider (or `EMAIL_PROVIDER` names one that isn't set up); the message names the settings and the runbook |
| `email_budget_exhausted`         | 429    | a recipient or the gateway has had its day's app mail (`Retry-After`)                        |
| `email_budget_unavailable`       | 503    | the budget couldn't be read or written, so nothing was sent                                  |
| `email_sender_not_verified`      | 422    | the sender's domain isn't set up: Email Sending's `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`; Resend's 403 naming the domain |
| `email_provider_limited`         | 429    | the account's rate or daily limit: Email Sending's `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`; Resend's 429 (`rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded`) |
| `email_send_failed`              | 502    | anything else the provider answered (Resend: a refused API key too)                          |

Every send is logged as `email.app.send` with the organization, app,
Worker, number of recipients, an HMAC of the first recipient, whether the
sender was the gateway's or the app's, the status (or `refused` and the
reason) and the attribution; never the subject, the bodies, the
attachments or an address.

`GET /api/integrations/email` (`integrationStatus({ env, provider: "email" })`)
answers `{ capability, requested, configured, ready, sender, senders, provider }`
without sending: `sender` is the From a message without `from` gets (null
unless configured), `senders` the patterns the gateway accepts from this
app (its installation's; empty on a hosted gateway), `provider` the one
mail goes out with
(`cloudflare` or `resend`; null unless configured). An app shows "sending
isn't set up" from `ready`, and offers only addresses `senders` allows.

**Local dev.** With no gateway, `sendEmail()` checks the message and the
sender the same way; the senders are `EVERYAPP_EMAIL_SENDERS` in the app's
`.dev.vars` (a comma-separated list or a JSON array), standing in for the
installation's, and unset, every `from` is refused as a gateway with none
set does; then it prints
`[everyapp dev] email to <n> recipients subject "<subject>"` and answers
`{ status: "logged", messageId: "dev-<uuid>" }`. With
`EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` in
`.dev.vars` it really sends, through Email Sending's REST API from the
developer's own account. The dev status's `provider` is the one the gateway
would pick from the same `.dev.vars` (`RESEND_API_KEY` and `EMAIL_PROVIDER`
count), though only Cloudflare's REST API sends from dev for now.

**Inbound mail** is not a capability: the app exports an `email()` handler
beside `everyApp()`'s `fetch` and declares it in the manifest,
`email: { inbound: true }`. The addresses are the installation's:
`everyapp email set --inbound "*@example.com" --inbound support@mail.example.com`
in the app's directory (`*@` is a zone apex's catch-all; subdomains take
literal addresses) stores them on the gateway and creates the Email
Routing rules that send them to the app's Worker at once, recorded as the
app's, removing those the list drops and asking (or taking
`--enable-email-routing`) before it turns routing on for a domain;
`everyapp deploy` keeps the rules in step with the stored list (and
removes them when the manifest drops the declaration); `delete --purge`
removes them. The deploy policy keeps refusing the `email` trigger
([docs/runbooks/email-sending-setup.md](runbooks/email-sending-setup.md#inbound-mail-to-an-app)).
The handler runs with no identity: its gateway calls pass
`for: { background: true, organizationId }` and treat the message as
untrusted.

## Gateway services: members

`members` is a capability the gateway performs itself: an app reads the
members of its organization who can open it now. An app that acts for
people outside a request (a cron that emails reports, an alert) asks the
gateway at that moment instead of trusting a copy it kept, so people who
left the organization, were deactivated or lost the app stop receiving
its mail. It needs no gateway setting.

| Capability | Gateway settings | Route                                 | Access |
| ---------- | ---------------- | ------------------------------------- | ------ |
| `members`  | none             | `GET /api/integrations/members/list`  | `read` |

An app lists it:

```ts
capabilities: {
  members: { access: "read", why: "Whom scheduled reports go to." },
},
```

and reads it:

```ts
import { listMembers } from "@every-app/sdk/server";

const { members } = await listMembers({ env }); // the request's, or withOrganization()'s
// [{ id, email, name, role: "owner" | "admin" | "member" }, ...]
```

**Who is listed** is who the perimeter lets open the app
(`hasAppAccess` in `apps/every-app-gateway/src/perimeter/betterAuthAuthenticator.ts`):
members of the organization the call is for, not deactivated, in an active
organization, and, for an organization's own app, granted it (everyone
for `access: "everyone"`, otherwise whom admins granted, directly or through
a group). A shared app
lists every live member of the organization its call names. `id` is the
identity's `sub` (`getEveryAppUser().id`); `name` is empty when the person
set none.

**What the gateway checks**, in order:

| Code                            | Status | When                                                                     |
| ------------------------------- | ------ | ------------------------------------------------------------------------ |
| `integration_method_not_allowed` | 405   | anything but `GET`                                                       |
| `capability_not_requested`      | 403    | the manifest doesn't list `members` with `access: "read"`                |
| `caller_*`                      | 401/403 | the call's organization, as for every capability call (attribution)     |
| `integration_agent_not_allowed` | 403    | an agent's tool call: the directory is the app's to read, not an agent's |

Every list is logged as `members.app.list` with the organization, app,
count and attribution, never an address. `GET /api/integrations/members`
(`integrationStatus({ env, provider: "members" })`) answers
`{ capability, requested, configured: true, ready }`.

In local dev (`everyapp dev`, no binding) there is no directory:
`listMembers()` answers the request's signed-in user alone, and no one for
background work.

## Gateway services: events

Events are a service the gateway performs itself, and not a capability: an
app lists nothing in its manifest to emit them, the way it lists nothing
to log. It calls `emit()` from `@every-app/sdk/server` with a name and a
JSON object, and the gateway delivers it as `app.<id>.<name>` to the
organization's subscriptions that match (signed webhooks, or email to
owners and admins), beside the gateway's own events (a member joined, a
cap was reached, an agent's tool call was blocked).

```ts
import { emit } from "@every-app/sdk/server";

await emit({
  env, // whose: the request being served, or withOrganization()'s organization
  event: "invoice.paid", // delivered as app.<id>.invoice.paid
  data: { invoiceId: "inv_42", total: 1200 },
});
```

The call is attributed like any gateway call (`POST /api/events/emit` over
the `EVERY_APP_GATEWAY` binding). `data` is at most 8 KiB, and a key named
like a credential (`token`, `secret`, `password`, `session`, ...) is
refused, so an event can't carry one by accident; 600 emits per app per
hour. Emits are not provider calls: not counted in usage, not capped. The
agent docs page is
[/docs/agent/events](https://everyapp.com/docs/agent/events); the design is
[docs/design/2026-10-events-out.md](design/2026-10-events-out.md).

## MCP apps

An MCP app (a provider app in the code) offers an `api_key` provider's data
to members' AI clients directly, as an app of the gateway's own with no
page and nothing to deploy: the operator turns it on (`pnpm everyapp mcp on
dataforseo`; `provider on|off` still run `mcp on|off` through launch week,
as hidden routes, while `provider list` is the provider registry's) and sets the
key as for any capability; the gateway serves a curated set of the
provider's tools on its `/mcp` under `<id>_<tool>` names. The registry is
`PROVIDER_APPS` in `packages/sdk/src/internal/providerApps.ts`; the row is
an `apps` row on tier `provider` with no hostname or Worker, whose generated
manifest lists the capability with `access: "read"`, so the key's need shows
wherever an app's settings do. Each tool call goes through the same checks
as an app's capability call (the provider's hosts, the account-wide paths,
the key, the cost tap) and is counted and audited against the provider row.
The agent docs page is
[/docs/agent/mcp](https://everyapp.com/docs/agent/mcp#mcp-apps) ("MCP apps");
how the launcher shows one is [docs/design/2026-10-mcp-apps-ui.md](design/2026-10-mcp-apps-ui.md). An MCP server is not a capability: any remote one is added by its URL as an MCP app of its own (`pnpm everyapp mcp add <url>`; [docs/design/2026-10-mcp-by-url.md](design/2026-10-mcp-by-url.md), and "MCP apps" on the same agent page).

## Limits today

- One key, client or gateway sender per capability, shared by every app and
  every organization that lists it (an app's own senders are per installed
  app, one list for every organization a shared app serves), so a
  provider's limits are shared too (Meta's
  app review tiers, TikTok's user caps, Workers AI's per-account rate
  limits). Whoever can deploy an app can list any capability, as for AI
  providers (deploying already takes credentials that can change the
  gateway).
- Calls are counted per organization, app, member and provider, with the
  provider's reported cost (Manage workspace → Usage; `usage_daily`,
  `usage_monthly`), and an owner or admin can cap an app's provider calls
  per month there, or set one default cap for every app without its own
  (off by default; over it, `app_monthly_cap_exceeded`, 429). App mail is
  the one capability with budgets (per recipient address and per gateway,
  not per organization).
- A hosted gateway sends app mail from its own sender only, and apps on the
  dispatch tier declare no inbound mail (the hosted deploy API refuses it).
- Keys and clients live in gateway Worker secrets, not encrypted in D1 with
  rotation in the UI, as the full design has it.
- OAuth scope sets are held at the token endpoint only. API calls don't
  pass through the gateway, so the sets' route allowlist is tested data
  that enforces nothing yet: the boundary is which tokens an app can
  obtain, not what it does with them. A Google token is narrow per app
  only when the app asks for the status's scopes without
  `include_granted_scopes`; a shared Microsoft client hands back everything
  the person consented to, which the gateway refuses rather than narrows;
  tokens obtained before a gateway deploy work until they need a refresh.
