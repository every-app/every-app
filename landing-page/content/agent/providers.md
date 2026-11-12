---
title: "API providers: the registry and the catalog"
description: "What an API provider is, the built-in catalog and the providers a Gateway registers, how an app lists and calls one, the spec's fields, OAuth providers a person connects once and allows each app to use, and the everyapp provider commands."
---

An **API provider** is an API the Gateway holds a key (or an OAuth client) for and brokers calls to: DataForSEO, Stripe, Google. An app lists it in `everyapp.config.ts` and calls the provider's real URLs; the Gateway adds the credential, so the app never holds it. One key per Gateway serves every app. Providers come from two places:

- the **built-in catalog** in the SDK (the table at the end), and
- a Gateway's own **rows**, registered with `everyapp provider add <spec>` for an API the catalog lacks. A row never shadows a catalog id. Every OAuth provider is a row, most written from a preset when an app that lists it deploys.

Kinds: `api_key` (the Gateway puts the key on calls to the provider's hosts; listed under `capabilities`), `ai` (an OpenAI-compatible model provider behind the AI proxy; listed under `providers`, see [ai](/docs/agent/ai)), `oauth_client` (each person connects their own account once and allows each app to use it; `capabilities` with `scopes`), and `service` (`email`, `members`: the Gateway does the work).

## How an app lists one

```ts
capabilities: {
  dataforseo: { access: "read", why: "Keyword research." },
  stripe: { access: "write", why: "Creates refunds." },
  "google-workspace": { scopes: ["gmail.modify"], why: "Mirrors your Gmail." },
},
// One the app works without: list it in an optional feature too.
features: {
  refunds: { name: "Refunds", why: "Refunds from the order page.", capabilities: ["stripe"] },
},
```

```ts
const fetchStripe = integrationFetch({ env, provider: "stripe" });
const res = await fetchStripe("https://api.stripe.com/v1/charges?limit=10");
```

The deploy checks each id against the catalog and the Gateway's rows (`CAPABILITY_UNKNOWN` otherwise). The deployed entry is the grant: a call outside it is `403 capability_not_requested`. `access: "write"` unlocks the spec's write methods; an AI client's read-only call still can't use them (`integration_read_only`). A key that isn't set answers `503 integration_not_configured` with setup info, and the app shows Needs setup until a required one is set. `integrationStatus()` says whether it's ready without calling.

## The spec

A provider the catalog lacks is one JSON object; `everyapp provider add stripe.json` (or an https URL) registers it, then asks for its key.

```json
{
  "id": "stripe",
  "name": "Stripe",
  "docs": "https://dashboard.stripe.com/apikeys",
  "hosts": ["api.stripe.com"],
  "auth": { "kind": "bearer", "secret": "STRIPE_API_KEY" },
  "access": ["read", "write"],
  "readMethods": ["GET"],
  "writeMethods": ["POST", "DELETE"]
}
```

- Required: `id` (lowercase, 2 to 40 characters, not a catalog id), `name`, `docs` (where the key comes from), `hosts` (at most 20 bare public hosts: the only ones the key is sent to) or `hostSetting` (a setting naming the operator's own host), and `auth`.
- Optional: `description`, `api`, `secrets` (`[{ name, hint }]`), `access`, `readMethods`, `writeMethods`, `accountWidePaths` (path segment runs always refused, like an account's keys listing), `data` (`per-call` or `account`; `account` providers are self-hosted only), `hint`, `smoke`, `cost` (with `responseField`, read into the usage counters and dollar caps), `rate`, `example`, `verified`, `tags`.
- `auth.kind`: `bearer` (`Authorization: Bearer <KEY>`, `scheme` replaces the word), `header` (`header` and `prefix`), `query` (`param`; the key never comes back in a redirect or answer), or `basic` (`as`: `password` with a `user`, `username`, or `pair`).
- `mode: "ai"` makes an OpenAI-compatible model provider: `baseUrl`, `auth`, `models`, `defaultModel`, optional `embeddingsModel`, `routes`, `chatRoute`, `embeddingsRoute`. [ai](/docs/agent/ai)

The rules (`PROVIDER_SPEC_INVALID` lists every problem): a spec names settings and never holds a value. Every setting starts with the id upper-cased (`STRIPE_` for `stripe`) and is nobody else's (`PROVIDER_SECRET_TAKEN`). Hosts are public DNS names, never the Gateway's own (`PROVIDER_HOST_REFUSED`). A row's key is read only for the hosts and auth it was set for, so after `provider add --replace` the key must be set again. Only the Cloudflare login, or an owner or admin through `everyapp_provider_add`, writes rows.

## OAuth providers: upload a client, the Gateway runs the flow

For APIs that act on a person's own account (Google, Microsoft 365, Slack, GitHub, Notion):

1. The provider is a registered row. Deploying or installing an app that lists a preset's id (`google-workspace`, `github-oauth`) writes its row; an owner or admin can add it first with `everyapp provider add github-oauth`, which prints the redirect URI (`https://<gateway>/connect/<id>/callback`) to register in the provider's console and then asks for the client. Or paste it in **Manage workspace → Providers**, where the secret is sealed in D1. A client set as Worker secrets (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`) wins over a pasted one.
2. The app lists the provider's own scopes it needs: `capabilities: { "github-oauth": { scopes: ["repo"], why: "…" } }`.
3. A person connects **once, to EveryApp**. The app sends them to `connectUrl({ env, provider, returnTo })`, and the Gateway picks what happens:
   - No connection, an expired one, or one that lacks a scope the app lists: the provider's consent, asked for every scope the organization's apps list for the provider. The callback stores the connection as that person's and allows the app the connect started in.
   - A connection that holds what the app lists: the Gateway's own Allow page (`Allow <app> to use your <provider> account?`, with **Don't allow** and **Allow**). No trip to the provider.
   - A connection the person already allowed the app to use: straight back to `returnTo`.
4. The app calls the provider's URLs with `integrationFetch()`, whether the person is there or not (background work names them with `for: { background: true, userId }`). The Gateway refreshes the token. It refuses any token carrying more scopes than were asked, which is the scopes the organization's apps list. The answer is `409 integration_not_connected` with a `connectPath` to send the person to when there is no connection, when the person hasn't allowed this app, or when the app now lists a scope the connection lacks or the person hasn't allowed.

An app the person hasn't allowed can't use their connection, in the foreground or the background. An app that requires an OAuth provider doesn't open for a person until they have connected it and allowed the app: opening it shows the Gateway's setup dialog with a Connect, Allow or Reconnect button. A provider an optional feature lists (`features.<id>.capabilities`) is optional and never blocks: name it in a feature when the app works without it and shows its own Connect button. A connection is never used for another person. App code and `everyapp.config.ts` are the same as before: the app's Connect button and `connectUrl()` lead to the provider or to the Allow page.

What this gives up:

- Allowing an app is a yes or no, not a limit on scopes. An allowed app can use every scope the connection holds, not only the ones it lists. The Allow page shows only the scopes the app lists; Your connections → Accounts lists every scope the connection holds.
- The provider's consent lists the scopes of every app in the organization, including apps the person never opens.
- A person has one account per provider. Connecting another account replaces the connection, and the other apps ask for access again.

Presets (`everyapp provider presets`): `google-workspace`, `microsoft-365`, `slack`, `github-oauth`, `notion-oauth`, `linear-oauth`, `gitlab-oauth`, `atlassian`, `hubspot-oauth`, `zoom`, `dropbox`, `spotify`. Any other OAuth 2 API is a spec with `auth.kind: "oauth2-user"`.

### The spec: `auth.kind: "oauth2-user"`

The common fields, with `hosts` the API hosts the token goes to, and an `auth` block: `authorizeUrl`, `tokenUrl`, optional `revokeUrl` and `revokeMethod`, `clientId` and optional `clientSecret` (setting names under the id's prefix), `inject` (`form` or `basic`), `pkce`, `scopeSeparator` (`space` or `comma`), `scopePrefix` (joined onto an app's short scope), `authorizeParams`, `tokenHeaders`, `identity` (`{ url, label, id? }`, to name the connection), `tolerated` (extra scopes a token may carry), `resource` (the RFC 8707 resource the tokens are for; an MCP app's own `<id>-mcp` row keeps the scopes its server grants; any other row is checked as usual) and `issuer` (the RFC 8414 issuer; a callback's `iss` must equal it).

Disconnecting (Your connections → Accounts, Manage workspace → Providers, `everyapp provider disconnect <id> --user <email>`, `everyapp_provider_disconnect`) deletes the connection, and every app stops using it at once. The Gateway's UI and the tool also revoke it at the provider, when the spec has a `revokeUrl`. The CLI holds no token, so after its disconnect the grant stays at the provider. With `--app <app>` (the tool's `app`), only that app's access goes and the connection stays. Removing a member or the provider deletes the connections. A member losing an app, or the app being deleted, removes only that app's access. `everyapp provider connections [--user] [--provider] [--app] [--all]` lists one row per person per provider with the apps allowed to use it, never a token. `--app` narrows it to the connections one app may use.

## Rows `mcp add` writes

A remote MCP app's credential is a provider row `<id>-mcp` (`treg` → `treg-mcp`), written with the app by `everyapp mcp add <url>`. Its `hosts` is the MCP URL's host alone, so the key or token goes nowhere else.

- `--auth bearer|header|query|basic`: an `api_key` row whose value is `<ID>_MCP_TOKEN` (`everyapp secret set TREG_MCP_TOKEN`).
- `--auth oauth`: an `oauth2-user` row from the server's discovered metadata, with `resource` and `issuer`, the client registered by DCR or given with `--client-id`, and the discovered scopes and `scopes_supported` as `tolerated`. Each member connects their own account in the app.
- `--provider <id>`: an existing provider instead (`elevenlabs`). The URL's host must be one of its hosts (`REMOTE_MCP_PROVIDER_HOST`).

Adding the app again with another credential replaces the row and deletes its connections. `mcp remove` leaves the row with its organization; `provider remove <id>-mcp` removes it.

## Specs an app bundles

An app that needs a provider outside the catalog commits its spec as `.everyapp/providers/<id>.json` (`provider show <id> --save` writes one). `everyapp dev` uses it locally; `deploy` and `install` register it on the Gateway after the person's yes (`--register-providers`); `release` carries it.

## The commands

```sh
everyapp provider add openrouter        # a catalog provider: where the key comes from, then asks for it
everyapp provider add stripe.json       # register a spec (file or https URL), then its key
everyapp provider add github-oauth [--client-id <id>]   # an OAuth preset: its row, then its client
everyapp provider list [--all]          # the providers in use: key state, apps listing each; --all adds the rest of the catalog
everyapp provider show stripe [--save]  # its setup facts; --json carries the whole spec
everyapp provider remove stripe [--force]
everyapp provider presets
everyapp provider connections
everyapp provider disconnect github-oauth --user ben@example.com
everyapp provider disconnect google-workspace --user ben@example.com --app openmail   # only OpenMail's access
```

Keys can also be set alone with `everyapp secret set STRIPE_API_KEY`. `--from-env` reads them from the environment, and piped `NAME=value` lines work. From an AI client: [the provider tools](/docs/agent/mcp#provider-tools).

## Local development

`everyapp dev` has no Gateway: the SDK calls a provider directly with the developer's key from `.dev.vars` under the Gateway's setting name, using the catalog's spec or the bundled one. For an OAuth provider, `.dev.vars` holds a token as `<PREFIX>_ACCESS_TOKEN` (`devAccessTokenName()`). Or use `everyapp dev --gateway <url>` to go through a real Gateway.

## The catalog

<!-- prettier-ignore-start -->
<!-- providers-catalog:begin (generated from packages/sdk/src/internal/capabilities.ts by packages/cli/src/docs/providersCatalog.ts; pnpm -C packages/cli docs:update) -->

The built-in catalog has 58 providers (49 API-key, 9 AI) and 12 OAuth presets. Where each key comes from, and a smoke request, are on [setup/providers](/docs/agent/setup/providers) and on [the provider pages](/docs/providers).

| Id | Name | Kind | Settings | Hosts | How the key is sent |
| --- | --- | --- | --- | --- | --- |
| `dataforseo` | DataForSEO | `api_key` | `DATAFORSEO_API_KEY` | `api.dataforseo.com`, `sandbox.dataforseo.com` | `Authorization: Basic <DATAFORSEO_API_KEY>`, the value `login:password` base64-encoded (or sent as it is when it holds no colon: already encoded) |
| `context` | Context.dev | `api_key` | `CONTEXT_API_KEY` | `api.context.dev` | `Authorization: Bearer <CONTEXT_API_KEY>` |
| `stripe` | Stripe | `api_key` | `STRIPE_API_KEY` | `api.stripe.com`, `files.stripe.com` | `Authorization: Bearer <STRIPE_API_KEY>` |
| `lemonsqueezy` | Lemon Squeezy | `api_key` | `LEMONSQUEEZY_API_KEY` | `api.lemonsqueezy.com` | `Authorization: Bearer <LEMONSQUEEZY_API_KEY>` |
| `paddle` | Paddle | `api_key` | `PADDLE_API_KEY` | `api.paddle.com`, `sandbox-api.paddle.com` | `Authorization: Bearer <PADDLE_API_KEY>` |
| `shopify` | Shopify | `api_key` | `SHOPIFY_API_TOKEN`, `SHOPIFY_HOST` | the host `<SHOPIFY_HOST>` names (a bare host or an https origin) | `X-Shopify-Access-Token: <SHOPIFY_API_TOKEN>` |
| `plaid` | Plaid | `api_key` | `PLAID_SECRET` | `sandbox.plaid.com`, `production.plaid.com` | `PLAID-SECRET: <PLAID_SECRET>` |
| `attio` | Attio | `api_key` | `ATTIO_API_KEY` | `api.attio.com` | `Authorization: Bearer <ATTIO_API_KEY>` |
| `hubspot` | HubSpot | `api_key` | `HUBSPOT_API_TOKEN` | `api.hubapi.com` | `Authorization: Bearer <HUBSPOT_API_TOKEN>` |
| `pipedrive` | Pipedrive | `api_key` | `PIPEDRIVE_API_TOKEN` | `api.pipedrive.com` | `x-api-token: <PIPEDRIVE_API_TOKEN>` |
| `airtable` | Airtable | `api_key` | `AIRTABLE_API_TOKEN` | `api.airtable.com` | `Authorization: Bearer <AIRTABLE_API_TOKEN>` |
| `notion` | Notion | `api_key` | `NOTION_API_TOKEN` | `api.notion.com` | `Authorization: Bearer <NOTION_API_TOKEN>` |
| `postmark` | Postmark | `api_key` | `POSTMARK_API_TOKEN` | `api.postmarkapp.com` | `X-Postmark-Server-Token: <POSTMARK_API_TOKEN>` |
| `sendgrid` | SendGrid | `api_key` | `SENDGRID_API_KEY` | `api.sendgrid.com`, `api.eu.sendgrid.com` | `Authorization: Bearer <SENDGRID_API_KEY>` |
| `twilio` | Twilio | `api_key` | `TWILIO_API_SECRET`, `TWILIO_API_KEY` | `api.twilio.com` | `Authorization: Basic base64(<TWILIO_API_KEY>:<TWILIO_API_SECRET>)` |
| `intercom` | Intercom | `api_key` | `INTERCOM_API_TOKEN` | `api.intercom.io`, `api.eu.intercom.io`, `api.au.intercom.io` | `Authorization: Bearer <INTERCOM_API_TOKEN>` |
| `crisp` | Crisp | `api_key` | `CRISP_API_KEY`, `CRISP_API_IDENTIFIER` | `api.crisp.chat` | `Authorization: Basic base64(<CRISP_API_IDENTIFIER>:<CRISP_API_KEY>)` |
| `granola` | Granola | `api_key` | `GRANOLA_API_KEY` | `public-api.granola.ai` | `Authorization: Bearer <GRANOLA_API_KEY>` |
| `linear` | Linear | `api_key` | `LINEAR_API_KEY` | `api.linear.app` | `Authorization: <LINEAR_API_KEY>` |
| `github` | GitHub | `api_key` | `GITHUB_API_TOKEN` | `api.github.com` | `Authorization: Bearer <GITHUB_API_TOKEN>` |
| `gitlab` | GitLab | `api_key` | `GITLAB_API_TOKEN` | `gitlab.com` | `PRIVATE-TOKEN: <GITLAB_API_TOKEN>` |
| `vercel` | Vercel | `api_key` | `VERCEL_API_TOKEN` | `api.vercel.com` | `Authorization: Bearer <VERCEL_API_TOKEN>` |
| `cloudflare` | Cloudflare | `api_key` | `CLOUDFLARE_PROVIDER_API_TOKEN` | `api.cloudflare.com` | `Authorization: Bearer <CLOUDFLARE_PROVIDER_API_TOKEN>` |
| `posthog` | PostHog | `api_key` | `POSTHOG_PERSONAL_API_KEY` | `us.posthog.com`, `eu.posthog.com` | `Authorization: Bearer <POSTHOG_PERSONAL_API_KEY>` |
| `mixpanel` | Mixpanel | `api_key` | `MIXPANEL_SERVICE_ACCOUNT_SECRET`, `MIXPANEL_SERVICE_ACCOUNT_USERNAME` | `mixpanel.com`, `eu.mixpanel.com`, `in.mixpanel.com`, `data.mixpanel.com`, `data-eu.mixpanel.com`, `data-in.mixpanel.com`, `api.mixpanel.com`, `api-eu.mixpanel.com`, `api-in.mixpanel.com` | `Authorization: Basic base64(<MIXPANEL_SERVICE_ACCOUNT_USERNAME>:<MIXPANEL_SERVICE_ACCOUNT_SECRET>)` |
| `segment` | Segment | `api_key` | `SEGMENT_WRITE_KEY` | `api.segment.io`, `events.eu1.segmentapis.com` | `Authorization: Basic base64(<SEGMENT_WRITE_KEY>:)` |
| `supabase` | Supabase | `api_key` | `SUPABASE_SECRET_KEY`, `SUPABASE_HOST` | the host `<SUPABASE_HOST>` names (a bare host or an https origin) | `apikey: <SUPABASE_SECRET_KEY>` |
| `turso` | Turso | `api_key` | `TURSO_API_TOKEN` | `api.turso.tech` | `Authorization: Bearer <TURSO_API_TOKEN>` |
| `turso-db` | Turso database | `api_key` | `TURSO_DB_AUTH_TOKEN`, `TURSO_DB_HOST` | the host `<TURSO_DB_HOST>` names (a bare host or an https origin) | `Authorization: Bearer <TURSO_DB_AUTH_TOKEN>` |
| `neon` | Neon | `api_key` | `NEON_API_KEY` | `console.neon.tech` | `Authorization: Bearer <NEON_API_KEY>` |
| `pinecone` | Pinecone | `api_key` | `PINECONE_API_KEY`, `PINECONE_HOST` | `api.pinecone.io`, the host `<PINECONE_HOST>` names (a bare host or an https origin) | `Api-Key: <PINECONE_API_KEY>` |
| `mapbox` | Mapbox | `api_key` | `MAPBOX_ACCESS_TOKEN` | `api.mapbox.com` | `?access_token=<MAPBOX_ACCESS_TOKEN>` on the URL, in place of any the app sent |
| `openweather` | OpenWeather | `api_key` | `OPENWEATHER_API_KEY` | `api.openweathermap.org`, `pro.openweathermap.org`, `history.openweathermap.org`, `tile.openweathermap.org`, `maps.openweathermap.org` | `?appid=<OPENWEATHER_API_KEY>` on the URL, in place of any the app sent |
| `daytona` | Daytona | `api_key` | `DAYTONA_API_KEY` | `app.daytona.io` | `Authorization: Bearer <DAYTONA_API_KEY>` |
| `voyage` | Voyage AI | `api_key` | `VOYAGE_API_KEY` | `api.voyageai.com` | `Authorization: Bearer <VOYAGE_API_KEY>` |
| `perplexity` | Perplexity | `api_key` | `PERPLEXITY_API_KEY` | `api.perplexity.ai` | `Authorization: Bearer <PERPLEXITY_API_KEY>` |
| `jina` | Jina AI | `api_key` | `JINA_API_KEY` | `api.jina.ai`, `r.jina.ai`, `s.jina.ai` | `Authorization: Bearer <JINA_API_KEY>` |
| `replicate` | Replicate | `api_key` | `REPLICATE_API_TOKEN` | `api.replicate.com` | `Authorization: Bearer <REPLICATE_API_TOKEN>` |
| `huggingface` | Hugging Face Inference | `api_key` | `HUGGINGFACE_API_TOKEN` | `router.huggingface.co` | `Authorization: Bearer <HUGGINGFACE_API_TOKEN>` |
| `firecrawl` | Firecrawl | `api_key` | `FIRECRAWL_API_KEY` | `api.firecrawl.dev` | `Authorization: Bearer <FIRECRAWL_API_KEY>` |
| `exa` | Exa | `api_key` | `EXA_API_KEY` | `api.exa.ai` | `x-api-key: <EXA_API_KEY>` |
| `tavily` | Tavily | `api_key` | `TAVILY_API_KEY` | `api.tavily.com` | `Authorization: Bearer <TAVILY_API_KEY>` |
| `serper` | Serper | `api_key` | `SERPER_API_KEY` | `google.serper.dev`, `scrape.serper.dev` | `X-API-KEY: <SERPER_API_KEY>` |
| `brave-search` | Brave Search | `api_key` | `BRAVE_SEARCH_API_KEY` | `api.search.brave.com` | `X-Subscription-Token: <BRAVE_SEARCH_API_KEY>` |
| `apify` | Apify | `api_key` | `APIFY_API_TOKEN` | `api.apify.com` | `Authorization: Bearer <APIFY_API_TOKEN>` |
| `deepgram` | Deepgram | `api_key` | `DEEPGRAM_API_KEY` | `api.deepgram.com`, `api.eu.deepgram.com`, `api.au.deepgram.com`, `api.in.deepgram.com` | `Authorization: Token <DEEPGRAM_API_KEY>` |
| `elevenlabs` | ElevenLabs | `api_key` | `ELEVENLABS_API_KEY` | `api.elevenlabs.io` | `xi-api-key: <ELEVENLABS_API_KEY>` |
| `assemblyai` | AssemblyAI | `api_key` | `ASSEMBLYAI_API_KEY` | `api.assemblyai.com`, `api.eu.assemblyai.com` | `Authorization: <ASSEMBLYAI_API_KEY>` |
| `newsapi` | NewsAPI | `api_key` | `NEWSAPI_API_KEY` | `newsapi.org` | `X-Api-Key: <NEWSAPI_API_KEY>` |
| `openai` | OpenAI | `ai` | `OPENAI_API_KEY` | `api.openai.com` | `Authorization: Bearer <OPENAI_API_KEY>` |
| `openrouter` | OpenRouter | `ai` | `OPENROUTER_API_KEY` | `openrouter.ai` | `Authorization: Bearer <OPENROUTER_API_KEY>` |
| `workers-ai` | Workers AI | `ai` | `WORKERS_AI_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`) | `api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai` | `Authorization: Bearer <WORKERS_AI_API_TOKEN>` |
| `ai-gateway` | Cloudflare AI Gateway | `ai` | `AI_GATEWAY_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`), `AI_GATEWAY_ID` | `gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_ID}` | `cf-aig-authorization: Bearer <AI_GATEWAY_API_KEY>` |
| `anthropic` | Anthropic | `ai` | `ANTHROPIC_API_KEY` | `api.anthropic.com` | `Authorization: Bearer <ANTHROPIC_API_KEY>` |
| `gemini` | Google Gemini | `ai` | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | `Authorization: Bearer <GEMINI_API_KEY>` |
| `mistral` | Mistral AI | `ai` | `MISTRAL_API_KEY` | `api.mistral.ai` | `Authorization: Bearer <MISTRAL_API_KEY>` |
| `groq` | Groq | `ai` | `GROQ_API_KEY` | `api.groq.com` | `Authorization: Bearer <GROQ_API_KEY>` |
| `cohere` | Cohere | `ai` | `COHERE_API_KEY` | `api.cohere.com` | `Authorization: Bearer <COHERE_API_KEY>` |

OAuth presets (`oauth_client`: registered when an app that lists one is deployed; the Gateway runs the flow; a person connects once, for the provider scopes their organization's apps list, and allows each app that uses it): `google-workspace`, `microsoft-365`, `slack`, `github-oauth`, `notion-oauth`, `linear-oauth`, `gitlab-oauth`, `atlassian`, `hubspot-oauth`, `zoom`, `dropbox`, `spotify`. Their consoles and redirect URIs are on [the provider pages](/docs/providers). Gateway services (`service`: no host, no spec): `email`, `members`.

<!-- providers-catalog:end -->
<!-- prettier-ignore-end -->
