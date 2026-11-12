# Capabilities the gateway holds

An app often needs a third-party API that isn't AI: DataForSEO for SEO data,
Context.dev for rendering pages, Slack's OAuth client, a way to
send email, Google's and Microsoft's mail and calendar, later GitHub. The
gateway holds the credential once, an app lists the capability in its
manifest, and the app calls through the gateway. No app holds the key. Per
installation, an app has its own secrets (`secret set NAME --app <id>`) and
the addresses it sends as and receives at (`everyapp email set`, below).

This is phase 0 of the integrations design (the integrations-hub research of
October 2026, which the repository no longer carries):
**API-key providers whose key the gateway holds**, **OAuth providers**
whose client the gateway holds and whose flow it runs, so a person connects
their own account once and allows each app that needs it
([below](#oauth-providers)),
and **gateway services**, things the gateway does itself for apps (sending
email, [below](#gateway-services-email); listing the organization's
members, [below](#gateway-services-members)).

AI providers are entries of the same catalog (`mode: "ai"`) and stay
separate in how an app reaches them:
`providers: ["openai", "openrouter", "workers-ai"]` and the
`/api/ai/<provider>` proxy, with their model and route allowlists. A gateway may also register API-key providers the catalog
doesn't have, as rows of its own ([Provider registry](#provider-registry)).

What comes next is designed, not built: the October 2026 redesign review
folds AI providers into this model behind one route and one SDK fetch (it
and the Google design were removed from the repository in #433, on
2026-10-24; organization-held OAuth accounts, which the Google design
proposed, were dropped on 2026-11-02). Both were
re-aligned on 2026-10-16 with the hosted-platform research
(`docs/research/2026-10-hosted-platform/`, PR #299; all three documents deleted from
main on 2026-10-24, git history at 5ef30882): in hosted, first-party apps share one Worker per app and third-party
apps get one Worker per organization on Workers for Platforms, and the gateway
learns the organization per call. Both documents were written when the
manifest key was `integrations` with `as` and `background` on each entry; read
them with this document's `capabilities` and
`{ access, why, docs }`.

## The four kinds

One catalog (`CAPABILITIES` in `packages/sdk/src/internal/capabilities.ts`)
defines the API-key, AI and service providers every gateway has; its
`mode` is the kind. OAuth providers are registered rows, written from the
presets in `packages/sdk/src/internal/oauthPresets.ts`. Three kinds are
capabilities: they take the same
manifest entry, `capabilities: { <id>: { access, why, docs } }`
(`access`, or for an OAuth provider `scopes`, the provider's own scope
strings, instead ([OAuth providers](#oauth-providers)), and `why`, `docs`
([docs/manifest-settings.md](manifest-settings.md))),
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
| `oauth_client` | Google, Microsoft 365, Slack, GitHub and others ([OAuth providers](#oauth-providers)): presets, each a row once an app that lists it is deployed or an operator adds it | runs the flow, keeps each person's tokens, and puts the person's token on calls from the apps that person allowed, to the provider's API hosts | `connectUrl({ env, provider })` to connect or to allow the app; `integrationFetch({ env, provider, for })` on the provider's real URLs | none: `scopes` | `scopes`, `connectPath`, `connection` |
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
included, from the setup guides in the agent docs:
[`landing-page/content/agent/setup/guides.md`](../landing-page/content/agent/setup/guides.md)
(one page per integration, served at https://everyapp.com/docs/agent/setup/guides; offline, `everyapp docs setup/guides`).

Everything the gateway holds for apps, in one table:

| What                        | Kind                | Gateway settings                                                                                                           | Set with (`pnpm everyapp secret set …`)                                                          | Used by                                              |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `openai`                    | AI provider         | `OPENAI_API_KEY`                                                                                                           | `OPENAI_API_KEY`                                                                                               | none at launch                                       |
| `openrouter`                | AI provider         | `OPENROUTER_API_KEY`                                                                                                       | `OPENROUTER_API_KEY`                                                                                           | OpenSEO; openmail with `AI_PROVIDER=openrouter` |
| `workers-ai`                | AI provider         | `WORKERS_AI_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID` (which `everyapp setup` sets)                                         | `WORKERS_AI_API_TOKEN` (the Workers AI page's prefilled token: Workers AI Read; a token made by hand needs Workers AI Read and Edit) | openmail with `AI_PROVIDER=workers-ai`          |
| `dataforseo`                | `api_key`           | `DATAFORSEO_API_KEY` (`login:password`, or its base64)                                                                     | `DATAFORSEO_API_KEY`                                                                                           | OpenSEO                                              |
| `context`                   | `api_key`           | `CONTEXT_API_KEY`                                                                                                          | `CONTEXT_API_KEY`                                                                                              | OpenSEO                                              |
| `email`                     | `service`           | `EMAIL_FROM` and `EMAIL_FROM_NAME` (or `EMAIL_FROM` alone as `Name <address>`), and one provider: Cloudflare Email Sending (the `EMAIL` binding; outside Workers `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) or Resend (`RESEND_API_KEY`); `EMAIL_PROVIDER` picks one when both are set | `EMAIL_FROM EMAIL_FROM_NAME` (or `EMAIL_FROM` alone as `Name <address>`; and `RESEND_API_KEY`, `EMAIL_PROVIDER`), after setting up the sending domain ([runbook](runbooks/email-sending-setup.md)); an app's own senders with `everyapp email set --sender` | openmail, OpenAnalytics, and the gateway's own mail |
| `members`                   | `service`           | none: the gateway reads its own directory                                                                                   | nothing to set                                                                                                 | OpenAnalytics (whom reports go to)                   |
| `google-workspace`, `microsoft-365`, `slack` | `oauth_client` (a row, from its preset) | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`; `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET`; `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | generated [below](#oauth-providers), or pasted in Manage workspace → Providers | OpenMail (Gmail); OpenCRM (mail and calendar capture); OpenSEO (Search Console and Analytics) |
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
| `granola` | Granola | `GRANOLA_API_KEY` | `public-api.granola.ai` | `Authorization: Bearer <GRANOLA_API_KEY>` | `read` | GET, POST |
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
| `daytona` | Daytona | `DAYTONA_API_KEY` | `app.daytona.io` | `Authorization: Bearer <DAYTONA_API_KEY>` | `read`, `write` | GET, HEAD; with `access: "write"` also POST, PUT, PATCH, DELETE |
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
| `openai`     | `OPENAI_API_KEY`                                 | `api.openai.com`                                     | inference, plus what the manifest's `ai.routes` names     |
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
both catalog API-key providers today; `read`, for email). An OAuth provider
takes `scopes` instead of `access` ([OAuth providers](#oauth-providers)). `everyapp dev` can't ask the gateway, so it accepts an id outside
the catalog and warns `CAPABILITY_NOT_IN_CATALOG`.

An entry may also say `why` for whoever sets it, and `docs` to replace the
registry's default page. A capability is required, and the app doesn't open
until it is set, unless an optional feature lists it
(`features.<id>.capabilities`): then the app opens without it and that
feature says what is missing ([docs/manifest-settings.md](manifest-settings.md)).

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
  queues) passes `for: { background: true }` to make the call the
  organization's. A shared app's Worker serves every organization, so its
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
`pnpm everyapp provider list` lists the providers in use (a key set, a row,
or an app listing it) with each key's state, and the rest of the catalog
with `--all`; `provider show <id>` shows one (its spec
with `--json`);
`provider remove <id>` removes a row. The spec's fields, the auth kinds,
the rules, the commands and their codes are the agent docs page
[/docs/agent/providers](https://everyapp.com/docs/agent/providers); the
boundary is B4 in `docs/security.md`, and the design is docs/design/2026-10-provider-registry.md.

<a id="oauth-clients"></a>

## OAuth providers

An OAuth provider is a capability too (`oauth_client`): the Gateway holds
the provider's client, runs the authorization-code flow, keeps the tokens
sealed in D1, refreshes them, and puts a person's token on an app's calls to
the provider's API. The app never sees a token or the client
(`docs/design/2026-11-oauth-simplify.md`, and
`docs/design/2026-11-oauth-one-connection.md` for one connection per
person). Every OAuth provider is a
registered row. Google (`google-workspace`), Microsoft 365
(`microsoft-365`), Slack (`slack`, its bot token), GitHub, Notion, Linear,
GitLab, Atlassian, HubSpot, Zoom, Dropbox and Spotify are presets
(`packages/sdk/src/internal/oauthPresets.ts`): deploying or installing an
app that lists one writes its row, and an operator can add one first
(`pnpm everyapp provider add google-workspace`). Any other provider is a
spec with `auth.kind: "oauth2-user"`. What differs between providers is data in the spec: the
endpoints, the API hosts, how scopes are separated and prefixed, extra
authorize parameters, how the account is named, and the scopes the Gateway
adds to every connect. The agent page is
[providers](../landing-page/content/agent/providers.md).

**For an operator.** Register one client per provider on its developer
console, with `https://<gateway>/connect/<id>/callback` as its redirect URI
and the scopes your apps list allowed on it, then hand it to the Gateway
(the commands are below), or paste it in Manage workspace → Providers
(sealed in `oauth_clients`; the Worker secret wins). A client you skip is
simply not offered: its status answers `configured: false`. One client
serves every app and organization on the Gateway, so a provider's limits
are shared too. Microsoft and Slack may hand back every scope a person ever
approved on a client. A connect asks for every scope the organization's
apps list, so apps share a client. A token that carries a scope no app
lists is refused.

**For an app.** List the provider with its own scope strings and why:

```ts
capabilities: {
  "google-workspace": {
    scopes: ["gmail.modify", "gmail.send"],
    why: "Mirrors your Gmail, writes reply drafts and sends when you press Send.",
  },
},
```

A short scope is joined onto the spec's prefix (Google's
`https://www.googleapis.com/auth/`), a full one is used as written, and `[]`
is a provider with no scopes (Notion). The Gateway adds the spec's identity
scopes (Google's `openid email`), so an app never lists them. An OAuth entry
takes no `access`: the scopes are the grant, for every method. The strict
validator refuses `access`, `background`, `optionalScopes` and
`redirectPaths` on it, each with what to write instead.

A person connects once, from inside an app: `connectUrl({ env, provider,
returnTo })` sends them to `https://<gateway>/connect/<id>?app=<app>`, where
the Gateway checks they may open the app and that its manifest lists the
provider. With no connection, or one that lacks a scope the app lists, it
asks the provider for every scope the organization's apps list and the
identity scopes (PKCE, a one-use state, never `include_granted_scopes`).
The connection belongs to that person, and the callback allows the app the
connect started in. With a connection that holds what the app lists, the
same link opens the Gateway's Allow page (`/oauth/app-access`), where the
person allows the app with no trip to the provider. An app the person
hasn't allowed can't use the connection. Allowing is a yes or no, not a
limit on scopes: an allowed app can use every scope the connection holds.
On the callback, the Gateway compares what the provider says it granted
with what was asked. On every refresh, it compares it with what the
connection holds. A token with more is refused and dropped (at refresh the
connection is marked expired). A provider that answers without a `scope`
field is taken as granted as asked.

```ts
import { connectUrl, integrationFetch } from "@every-app/sdk/server";

const google = integrationFetch({ env, provider: "google-workspace" });
const answer = await google("https://gmail.googleapis.com/gmail/v1/users/me/profile");
// 409 integration_not_connected: send the person to
// connectUrl({ env, provider: "google-workspace", returnTo: request.url })
```

The call uses the connection of the person behind it. Work no person
started, or a call on another member's behalf, names the member with
`for: { background: true, userId }` (sent as `x-everyapp-user`): an app may
use the connection of any member who allowed it, at any time. Only an
organization's own app may name a member, and only one who is still an
active member able to open the app.

**What the gateway checks** on a call to a provider's API, in order, each a
refusal with its code in `x-everyapp-error`:

| Code                           | Status | When                                                                                                    |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| `capability_not_requested`     | 403    | the deployed manifest doesn't list the provider                                                         |
| `integration_not_configured`   | 503    | the Gateway holds no client for it                                                                      |
| `integration_body_invalid`     | 400    | `x-everyapp-user` isn't a user id                                                                       |
| `integration_user_not_allowed` | 403    | a shared app or linked dev named a member with `x-everyapp-user`                                        |
| `integration_not_connected`    | 409    | no connection for this person (or the named member), they haven't allowed this app, it expired, or the app now lists a scope the connection lacks or the person hasn't allowed; the answer carries `connectPath` (`/connect/<id>?app=<app>`), `reconnect` and `missingScopes`. A named member who left, was deactivated or lost the app gets this too, and the app's access to their connection is removed |
| `invalid_integration_route`    | 400    | the host isn't one of the provider's API hosts                                                          |
| `integration_upstream_failed`  | 502    | the provider couldn't be reached                                                                        |

It then puts the token (refreshed first when due) on as `Authorization:
Bearer`, drops the app's `Authorization`, cookies, `x-http-method-override`
and every `x-everyapp-*` header and any `access_token` or `token` query key,
refuses to follow redirects, drops the provider's `set-cookie`, and streams
the answer back. There are no route, set or method rules: what the app may
do is what the scopes the connection holds let it do. Each call is logged
(`integration.proxy.call`) without the query, the body or the answer, and
an app's first call of a UTC day on a connection emits `connection.used`.

`GET /api/integrations/<id>` answers `{ capability, requested, configured,
ready, scopes, connectPath, connection }` for the person (or the named
member): `scopes` as the manifest lists them, `connectPath` the app's
connect path, and `connection` `{ label, scopes, ready, missingScopes?,
reconnect? }` or null (null too while the person hasn't allowed this app).
In local dev (`everyapp dev`, no binding) a token
you obtained yourself in `.dev.vars` as `<PREFIX>_ACCESS_TOKEN`
(`GOOGLE_WORKSPACE_ACCESS_TOKEN`) stands in for the connection; dev checks
the hosts only.

Removing a member deletes their connections, and removing a provider
deletes every connection to it. A member losing an app, or the app being
deleted, removes only that app's access. A person disconnects in
Your connections → Accounts, which lists each connection once with the apps
allowed to use it. Disconnect stops every app at once, and one app's access
can be removed on its own. An owner or admin does the same for anyone's
connection in Manage workspace → Providers.

<!-- oauth-clients:begin (generated from packages/sdk/src/internal/oauthPresets.ts by capabilitiesDoc.test.ts) -->

| Preset | Provider | Gateway secrets | Developer console | API hosts the token is sent to |
| --- | --- | --- | --- | --- |
| `google-workspace` | Google | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET` | https://console.cloud.google.com/apis/credentials | `gmail.googleapis.com`, `www.googleapis.com`, `searchconsole.googleapis.com`, `analyticsdata.googleapis.com`, `analyticsadmin.googleapis.com`, `openidconnect.googleapis.com` |
| `microsoft-365` | Microsoft 365 | `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET` | https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade | `graph.microsoft.com` |
| `slack` | Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | https://api.slack.com/apps | `slack.com` |
| `github-oauth` | GitHub | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | https://github.com/settings/developers | `api.github.com` |
| `notion-oauth` | Notion | `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` | https://www.notion.so/my-integrations | `api.notion.com` |
| `linear-oauth` | Linear | `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET` | https://linear.app/settings/api/applications | `api.linear.app` |
| `gitlab-oauth` | GitLab | `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | https://gitlab.com/-/user_settings/applications | `gitlab.com` |
| `atlassian` | Atlassian (Jira and Confluence) | `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` | https://developer.atlassian.com/console/myapps/ | `api.atlassian.com` |
| `hubspot-oauth` | HubSpot | `HUBSPOT_OAUTH_CLIENT_ID`, `HUBSPOT_OAUTH_CLIENT_SECRET` | https://developers.hubspot.com/ | `api.hubapi.com` |
| `zoom` | Zoom | `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | https://marketplace.zoom.us/develop/create | `api.zoom.us` |
| `dropbox` | Dropbox | `DROPBOX_OAUTH_CLIENT_ID`, `DROPBOX_OAUTH_CLIENT_SECRET` | https://www.dropbox.com/developers/apps | `api.dropboxapi.com`, `content.dropboxapi.com` |
| `spotify` | Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | https://developer.spotify.com/dashboard | `api.spotify.com` |

The commands, one per client you offer, once its provider is registered (each prompts for the values):

```bash
pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET
pnpm everyapp secret set MICROSOFT_365_CLIENT_ID MICROSOFT_365_CLIENT_SECRET
pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET
pnpm everyapp secret set GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET
pnpm everyapp secret set NOTION_OAUTH_CLIENT_ID NOTION_OAUTH_CLIENT_SECRET
pnpm everyapp secret set LINEAR_OAUTH_CLIENT_ID LINEAR_OAUTH_CLIENT_SECRET
pnpm everyapp secret set GITLAB_OAUTH_CLIENT_ID GITLAB_OAUTH_CLIENT_SECRET
pnpm everyapp secret set ATLASSIAN_CLIENT_ID ATLASSIAN_CLIENT_SECRET
pnpm everyapp secret set HUBSPOT_OAUTH_CLIENT_ID HUBSPOT_OAUTH_CLIENT_SECRET
pnpm everyapp secret set ZOOM_CLIENT_ID ZOOM_CLIENT_SECRET
pnpm everyapp secret set DROPBOX_OAUTH_CLIENT_ID DROPBOX_OAUTH_CLIENT_SECRET
pnpm everyapp secret set SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET
```

How each provider spells scopes. An app lists the provider's own scopes (`scopes` on its capability entry), short (joined onto the prefix) or in full; the Gateway adds the identity scopes to every connect:

| Preset | Separator | Scope prefix | Identity scopes |
| --- | --- | --- | --- |
| `google-workspace` | space | `https://www.googleapis.com/auth/` | `openid`, `email` |
| `microsoft-365` | space | `https://graph.microsoft.com/` | `User.Read`, `offline_access` |
| `slack` | comma | none | none |
| `github-oauth` | comma | none | none |
| `notion-oauth` | space | none | none |
| `linear-oauth` | comma | none | none |
| `gitlab-oauth` | space | none | `read_user` |
| `atlassian` | space | none | `read:me`, `offline_access` |
| `hubspot-oauth` | space | none | none |
| `zoom` | space | none | `user:read:user` |
| `dropbox` | space | none | none |
| `spotify` | space | none | none |

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
    env, // whose: the request being served, or `for` says
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

const { members } = await listMembers({ env }); // the request's, or the one `for` names
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
  env, // whose: the request being served, or `for` says
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
how the Gateway's UI shows one is [docs/design/2026-10-mcp-apps-ui.md](design/2026-10-mcp-apps-ui.md). An MCP server is not a capability: any remote one is added by its URL as an MCP app of its own (`pnpm everyapp mcp add <url>`; [docs/design/2026-10-mcp-by-url.md](design/2026-10-mcp-by-url.md), and "MCP apps" on the same agent page).

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
- An OAuth connection's boundary is the scopes the person approved on the
  provider's screen: the Gateway doesn't narrow within a scope (Google's
  `gmail.modify` includes sending) or between apps. An app the person
  allowed can use every scope the connection holds, not only the ones it
  lists, at any time, with no separate consent for work while the person is
  away.
