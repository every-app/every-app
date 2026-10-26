<!-- generated: pnpm -C packages/cli docs:update writes this file from the built-in catalog (packages/sdk/src/internal/capabilities.ts, through packages/cli/src/docs/providersCatalog.ts). Edit the catalog, never this file: a test fails CI when it is stale. -->

# Every catalog provider: its settings, its key and one check

For a coding agent setting up a provider the Gateway's built-in catalog has. Each provider is a section under its id, so `setup/providers.md#<id>` points at it. Where the provider has a file of its own in this folder (its **Guide**), follow that file and read this section as its summary. Read [README.md](README.md) first: its rules hold here too, above all that a key never goes through the chat.

A provider registered on one Gateway (`pnpm everyapp provider add`) is not in this file: `pnpm everyapp provider show <id>` prints its whole spec (its hint, settings, hosts, where the key comes from and its smoke request). The catalog has 74 providers: 47 API-key, 9 AI, 18 OAuth clients.

The smoke request needs the key, so it runs where the key is: the person's terminal, with the variable they read in hidden, or through the app that uses it. It is one call that costs nothing (unless marked charged).

## How a value gets in

The three ways of [README.md](README.md), one line each (the rules, and the codes a failure carries, are there):

- **The person types it**, in their own terminal in the `every-app` folder: `pnpm everyapp configure <app id>` (everything the app needs) or `pnpm everyapp secret set NAME` (one name), each value at a hidden prompt.
- **A command produced it**: pipe it straight in, `… | pnpm everyapp secret set NAME --json`, so it is never shown.
- **It is in an environment variable** the person read in hidden: `pnpm everyapp secret set NAME --from-env NAME --json`, or `pnpm everyapp configure <app id> --from-env --json`.

## Providers

| Id | Name | Kind | Settings | Guide |
| --- | --- | --- | --- | --- |
| [`dataforseo`](#dataforseo) | DataForSEO | API key | `DATAFORSEO_API_KEY` | [dataforseo.md](dataforseo.md) |
| [`context`](#context) | Context.dev | API key | `CONTEXT_API_KEY` | [context.md](context.md) |
| [`stripe`](#stripe) | Stripe | API key | `STRIPE_API_KEY` |  |
| [`lemonsqueezy`](#lemonsqueezy) | Lemon Squeezy | API key | `LEMONSQUEEZY_API_KEY` |  |
| [`paddle`](#paddle) | Paddle | API key | `PADDLE_API_KEY` |  |
| [`shopify`](#shopify) | Shopify | API key | `SHOPIFY_API_TOKEN`, `SHOPIFY_HOST` |  |
| [`plaid`](#plaid) | Plaid | API key | `PLAID_SECRET` |  |
| [`attio`](#attio) | Attio | API key | `ATTIO_API_KEY` |  |
| [`hubspot`](#hubspot) | HubSpot | API key | `HUBSPOT_API_TOKEN` |  |
| [`pipedrive`](#pipedrive) | Pipedrive | API key | `PIPEDRIVE_API_TOKEN` |  |
| [`airtable`](#airtable) | Airtable | API key | `AIRTABLE_API_TOKEN` |  |
| [`notion`](#notion) | Notion | API key | `NOTION_API_TOKEN` |  |
| [`postmark`](#postmark) | Postmark | API key | `POSTMARK_API_TOKEN` |  |
| [`sendgrid`](#sendgrid) | SendGrid | API key | `SENDGRID_API_KEY` |  |
| [`twilio`](#twilio) | Twilio | API key | `TWILIO_API_SECRET`, `TWILIO_API_KEY` |  |
| [`intercom`](#intercom) | Intercom | API key | `INTERCOM_API_TOKEN` |  |
| [`crisp`](#crisp) | Crisp | API key | `CRISP_API_KEY`, `CRISP_API_IDENTIFIER` |  |
| [`linear`](#linear) | Linear | API key | `LINEAR_API_KEY` |  |
| [`github`](#github) | GitHub | API key | `GITHUB_API_TOKEN` |  |
| [`gitlab`](#gitlab) | GitLab | API key | `GITLAB_API_TOKEN` |  |
| [`vercel`](#vercel) | Vercel | API key | `VERCEL_API_TOKEN` |  |
| [`cloudflare`](#cloudflare) | Cloudflare | API key | `CLOUDFLARE_PROVIDER_API_TOKEN` |  |
| [`posthog`](#posthog) | PostHog | API key | `POSTHOG_PERSONAL_API_KEY` |  |
| [`mixpanel`](#mixpanel) | Mixpanel | API key | `MIXPANEL_SERVICE_ACCOUNT_SECRET`, `MIXPANEL_SERVICE_ACCOUNT_USERNAME` |  |
| [`segment`](#segment) | Segment | API key | `SEGMENT_WRITE_KEY` |  |
| [`supabase`](#supabase) | Supabase | API key | `SUPABASE_SECRET_KEY`, `SUPABASE_HOST` |  |
| [`turso`](#turso) | Turso | API key | `TURSO_API_TOKEN` |  |
| [`turso-db`](#turso-db) | Turso database | API key | `TURSO_DB_AUTH_TOKEN`, `TURSO_DB_HOST` |  |
| [`neon`](#neon) | Neon | API key | `NEON_API_KEY` |  |
| [`pinecone`](#pinecone) | Pinecone | API key | `PINECONE_API_KEY`, `PINECONE_HOST` |  |
| [`mapbox`](#mapbox) | Mapbox | API key | `MAPBOX_ACCESS_TOKEN` |  |
| [`openweather`](#openweather) | OpenWeather | API key | `OPENWEATHER_API_KEY` |  |
| [`voyage`](#voyage) | Voyage AI | API key | `VOYAGE_API_KEY` |  |
| [`perplexity`](#perplexity) | Perplexity | API key | `PERPLEXITY_API_KEY` |  |
| [`jina`](#jina) | Jina AI | API key | `JINA_API_KEY` |  |
| [`replicate`](#replicate) | Replicate | API key | `REPLICATE_API_TOKEN` |  |
| [`huggingface`](#huggingface) | Hugging Face Inference | API key | `HUGGINGFACE_API_TOKEN` |  |
| [`firecrawl`](#firecrawl) | Firecrawl | API key | `FIRECRAWL_API_KEY` |  |
| [`exa`](#exa) | Exa | API key | `EXA_API_KEY` |  |
| [`tavily`](#tavily) | Tavily | API key | `TAVILY_API_KEY` |  |
| [`serper`](#serper) | Serper | API key | `SERPER_API_KEY` |  |
| [`brave-search`](#brave-search) | Brave Search | API key | `BRAVE_SEARCH_API_KEY` |  |
| [`apify`](#apify) | Apify | API key | `APIFY_API_TOKEN` |  |
| [`deepgram`](#deepgram) | Deepgram | API key | `DEEPGRAM_API_KEY` |  |
| [`elevenlabs`](#elevenlabs) | ElevenLabs | API key | `ELEVENLABS_API_KEY` |  |
| [`assemblyai`](#assemblyai) | AssemblyAI | API key | `ASSEMBLYAI_API_KEY` |  |
| [`newsapi`](#newsapi) | NewsAPI | API key | `NEWSAPI_API_KEY` |  |
| [`openai`](#openai) | OpenAI | AI | `OPENAI_API_KEY` | [openai.md](openai.md) |
| [`openrouter`](#openrouter) | OpenRouter | AI | `OPENROUTER_API_KEY` | [openrouter.md](openrouter.md) |
| [`workers-ai`](#workers-ai) | Workers AI | AI | `WORKERS_AI_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`) | [workers-ai.md](workers-ai.md) |
| [`ai-gateway`](#ai-gateway) | Cloudflare AI Gateway | AI | `AI_GATEWAY_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`), `AI_GATEWAY_ID` | [ai-gateway.md](ai-gateway.md) |
| [`anthropic`](#anthropic) | Anthropic | AI | `ANTHROPIC_API_KEY` |  |
| [`gemini`](#gemini) | Google Gemini | AI | `GEMINI_API_KEY` |  |
| [`mistral`](#mistral) | Mistral AI | AI | `MISTRAL_API_KEY` |  |
| [`groq`](#groq) | Groq | AI | `GROQ_API_KEY` |  |
| [`cohere`](#cohere) | Cohere | AI | `COHERE_API_KEY` |  |
| [`linkedin`](#linkedin) | LinkedIn | OAuth client | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |  |
| [`facebook`](#facebook) | Facebook | OAuth client | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |  |
| [`instagram`](#instagram) | Instagram | OAuth client | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` |  |
| [`threads`](#threads) | Threads | OAuth client | `THREADS_APP_ID`, `THREADS_APP_SECRET` |  |
| [`youtube`](#youtube) | YouTube | OAuth client | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | [google.md](google.md) |
| [`tiktok`](#tiktok) | TikTok | OAuth client | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` |  |
| [`tiktok-business`](#tiktok-business) | TikTok Business | OAuth client | `TIKTOK_BUSINESS_CLIENT_ID`, `TIKTOK_BUSINESS_CLIENT_SECRET` |  |
| [`reddit`](#reddit) | Reddit | OAuth client | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |  |
| [`pinterest`](#pinterest) | Pinterest | OAuth client | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` |  |
| [`discord`](#discord) | Discord | OAuth client | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |  |
| [`slack`](#slack) | Slack | OAuth client | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | [slack.md](slack.md) |
| [`mastodon`](#mastodon) | Mastodon | OAuth client | `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET`, `MASTODON_URL` |  |
| [`kick`](#kick) | Kick | OAuth client | `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` |  |
| [`twitch`](#twitch) | Twitch | OAuth client | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |  |
| [`tumblr`](#tumblr) | Tumblr | OAuth client | `TUMBLR_CLIENT_ID`, `TUMBLR_CLIENT_SECRET` |  |
| [`dribbble`](#dribbble) | Dribbble | OAuth client | `DRIBBBLE_CLIENT_ID`, `DRIBBBLE_CLIENT_SECRET` |  |
| [`google-workspace`](#google-workspace) | Google (Gmail, Calendar, Search Console and Analytics) | OAuth client | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET` | [google.md](google.md) |
| [`microsoft-365`](#microsoft-365) | Microsoft 365 (Outlook mail and calendar) | OAuth client | `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET` | [microsoft-365.md](microsoft-365.md) |

Gateway services have no key of this kind: `email`, `members` (sending mail is [email.md](email.md); the members list needs nothing).

## API-key providers

### dataforseo

**DataForSEO** (`api_key`): SEO data: keyword metrics, live search results, domain rankings, backlinks.

- **Settings:** `DATAFORSEO_API_KEY`
- **What the key is:** The API login and password from API Access, as login:password (or that pair base64-encoded); the Gateway sends them as HTTP Basic. login:password, or its base64; never the dashboard sign-in password.
- **Where the key comes from:** https://app.dataforseo.com/api-access
- **API reference:** https://docs.dataforseo.com/v3/
- **How it is sent:** `Authorization: Basic <DATAFORSEO_API_KEY>`, the value `login:password` base64-encoded (or sent as it is when it holds no colon: already encoded), to `api.dataforseo.com`, `sandbox.dataforseo.com` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; account-wide paths refused: `tasks_ready`, `tasks_fixed`, `id_list`, `errors`, `appendix/user_data`, `appendix/webhook_resend`
- **Smoke request:** `GET https://api.dataforseo.com/v3/appendix/user_data`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** per call. A Google SERP $0.002 per 10 results; a Labs task $0.012 plus $0.00012 per item. The Gateway reads each answer's `cost` field (US dollars) into the usage counters.
- **Rate:** not recorded
- **Verified:** 2026-10-25, live
- **Set it:** `pnpm everyapp secret set DATAFORSEO_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [dataforseo.md](dataforseo.md)

### context

**Context.dev** (`api_key`): Scrapes and renders web pages, JavaScript included.

- **Settings:** `CONTEXT_API_KEY`
- **What the key is:** An API key from the Context.dev dashboard; the Gateway puts it on every call as a bearer token.
- **Where the key comes from:** https://context.dev/
- **How it is sent:** `Authorization: Bearer <CONTEXT_API_KEY>`, to `api.context.dev` only, over https
- **What apps may do:** access `read`; GET, POST on any grant
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, live
- **Set it:** `pnpm everyapp secret set CONTEXT_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [context.md](context.md)

### stripe

**Stripe** (`api_key`): Payments: customers, subscriptions, invoices, charges and payouts.

- **Settings:** `STRIPE_API_KEY`
- **What the key is:** A restricted API key from the API keys page of the Stripe dashboard, with only the permissions the app needs. The Gateway sends it as a bearer token. A restricted key (rk_live_...) with only the permissions the app needs; a sandbox key (rk_test_... or sk_test_...) to try it.
- **Where the key comes from:** https://dashboard.stripe.com/apikeys
- **API reference:** https://docs.stripe.com/api
- **How it is sent:** `Authorization: Bearer <STRIPE_API_KEY>`, to `api.stripe.com`, `files.stripe.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, DELETE for an entry with `access: "write"`; account-wide paths refused: `v1/account`, `v1/accounts`, `v2/core/accounts`, `v1/webhook_endpoints`, `v2/core/event_destinations`, `v1/apps/secrets`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.stripe.com/v1/balance`, expecting 200; free. A restricted key needs Balance read for this one.
- **Cost:** per call. No per-call price; reads should average under 500 per transaction over 30 days, with at least 10,000 a month allowed.
- **Rate:** 100 a second. Live mode, per account; sandbox 25/s; most single endpoints 25/s; Search 20/s.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set STRIPE_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### lemonsqueezy

**Lemon Squeezy** (`api_key`): Merchant of record for software: stores, products, orders, subscriptions, license keys.

- **Settings:** `LEMONSQUEEZY_API_KEY`
- **What the key is:** An API key from Settings > API in Lemon Squeezy; the Gateway sends it as a bearer token. The API is JSON:API, so the app sends Accept and Content-Type application/vnd.api+json. An API key from Settings > API; a test mode key reaches test mode store data only.
- **Where the key comes from:** https://app.lemonsqueezy.com/settings/api
- **API reference:** https://docs.lemonsqueezy.com/api
- **How it is sent:** `Authorization: Bearer <LEMONSQUEEZY_API_KEY>`, to `api.lemonsqueezy.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `v1/users`, `v1/webhooks`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.lemonsqueezy.com/v1/users/me`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 300 a minute. 300 API calls per minute.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set LEMONSQUEEZY_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### paddle

**Paddle** (`api_key`): Paddle Billing: products, prices, customers, subscriptions and transactions.

- **Settings:** `PADDLE_API_KEY`
- **What the key is:** An API key from Paddle > My account > Settings > Authentication (API keys tab), with only the permissions the app needs; the Gateway sends it as a bearer token. Live and sandbox are separate hosts with separate keys. An API key (pdl_live_apikey_... or pdl_sdbx_apikey_...) with only the permissions the app needs; a sandbox key works on the sandbox host only.
- **Where the key comes from:** https://developer.paddle.com/api-reference/about/authentication/
- **API reference:** https://developer.paddle.com/api-reference/
- **How it is sent:** `Authorization: Bearer <PADDLE_API_KEY>`, to `api.paddle.com`, `sandbox-api.paddle.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `account`, `settings`, `notification-settings`, `notifications`, `simulations`, `simulation-runs`, `client-tokens`, `checkout-domains`, `verifications`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.paddle.com/event-types`, expecting 200; free. Paddle's own first request: needs no permissions. Send it to sandbox-api.paddle.com with a sandbox key.
- **Cost:** not recorded
- **Rate:** 240 a minute. Per IP address; pricing previews 1,000 a minute; 20 immediate-charge updates per subscription an hour.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set PADDLE_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### shopify

**Shopify** (`api_key`): One store's Admin API (GraphQL): products, orders, customers and inventory.

- **Settings:** `SHOPIFY_API_TOKEN`, `SHOPIFY_HOST`
- **What the key is:** An Admin API access token from a custom app created in the store's admin, sent in the X-Shopify-Access-Token header to the store's myshopify.com host. Shopify no longer lets stores create new admin custom apps, and Dev Dashboard tokens expire after 24 hours, which the Gateway can't refresh yet. SHOPIFY_API_TOKEN: The Admin API access token of a custom app made in the store's admin (Apps > Develop apps > the app > API credentials); it is shown once. SHOPIFY_HOST: The store's own host, like your-store.myshopify.com.
- **Where the key comes from:** https://shopify.dev/docs/apps/build/authentication-authorization/legacy/admin-custom-apps
- **API reference:** https://shopify.dev/docs/api/admin-graphql
- **How it is sent:** `X-Shopify-Access-Token: <SHOPIFY_API_TOKEN>`, to the host `<SHOPIFY_HOST>` names (a bare host or an https origin) only, over https
- **What apps may do:** access `write`;  on any grant, and POST for an entry with `access: "write"`; account-wide paths refused: `webhooks`, `storefront_access_tokens`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://<SHOPIFY_HOST>/admin/api/2026-10/shop.json`, expecting 200; free. The legacy REST read of the store; the Gateway forwards no GET for this entry, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** GraphQL cost points per second by plan: Standard 100, Advanced 200, Plus 1,000, enterprise 2,000.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set SHOPIFY_API_TOKEN SHOPIFY_HOST`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### plaid

**Plaid** (`api_key`): Bank data: accounts, balances, transactions and identity, for the Items an app links.

- **Settings:** `PLAID_SECRET`
- **What the key is:** Plaid needs a client_id and a secret on every call, in the JSON body or in the PLAID-CLIENT-ID and PLAID-SECRET headers. The Gateway puts on one header, so the app would have to send PLAID-CLIENT-ID itself. Every endpoint is a POST. The secret for one environment (Sandbox or Production) from the Keys page of the Plaid Dashboard.
- **Where the key comes from:** https://dashboard.plaid.com/developers/keys
- **API reference:** https://plaid.com/docs/api/
- **How it is sent:** `PLAID-SECRET: <PLAID_SECRET>`, to `sandbox.plaid.com`, `production.plaid.com` only, over https
- **What apps may do:** access `read`; POST on any grant; account-wide paths refused: `item/webhook/update`, `item/access_token/invalidate`, `item/remove`, `webhook_verification_key`, `dashboard_user`, `transfer`, `payment_initiation`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** Set per endpoint and per Item: /accounts/get allows 15 a minute per Item and 15,000 a minute per client.
- **Verified:** no: not checked against the provider's docs
- **Set it:** `pnpm everyapp secret set PLAID_SECRET`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### attio

**Attio** (`api_key`): CRM: people, companies, deals, lists, notes and tasks in one Attio workspace.

- **Settings:** `ATTIO_API_KEY`
- **What the key is:** An access token a workspace admin makes under Workspace settings > Developers, scoped to what the app needs; the Gateway sends it as a bearer token. Listing and searching records are POSTs, so an app that lists records needs write access. An access token from Workspace settings > Developers, with only the scopes the app needs.
- **Where the key comes from:** https://attio.com/help/reference/apps/generating-an-api-key
- **API reference:** https://docs.attio.com/rest-api/overview
- **How it is sent:** `Authorization: Bearer <ATTIO_API_KEY>`, to `api.attio.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `v2/self`, `v2/webhooks`, `v2/workspace_members`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.attio.com/v2/objects`, expecting 200; free. Lists the workspace's objects; needs the object_configuration:read scope. /v2/self answers 200 even for a revoked token.
- **Cost:** not recorded
- **Rate:** 100 a second. 100 reads and 25 writes per second; listing records and entries also has score-based limits.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set ATTIO_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### hubspot

**HubSpot** (`api_key`): CRM and marketing: contacts, companies, deals, tickets and more in one HubSpot account.

- **Settings:** `HUBSPOT_API_TOKEN`
- **What the key is:** An access token from a HubSpot legacy private app (Development > Legacy apps > Create legacy app > Private), scoped to what the app needs; the Gateway sends it as a bearer token. CRM search is a POST, so an app that searches needs write access. The access token of a legacy private app (Development > Legacy apps > the app > Auth), with only the scopes the app needs.
- **Where the key comes from:** https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview
- **API reference:** https://developers.hubspot.com/docs/api-reference/latest/overview
- **How it is sent:** `Authorization: Bearer <HUBSPOT_API_TOKEN>`, to `api.hubapi.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `account-info`, `settings/users`, `settings/v3/users`, `settings/teams`, `app-webhooks`, `webhooks`, `webhooks-journal`, `oauth`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.hubapi.com/account-info/2026-09/details`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 250000 a day. Private apps on Free and Starter: 100 per 10 seconds per app and 250,000 a day per account; Pro 190 and 625,000; Enterprise 190 and 1,000,000.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set HUBSPOT_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### pipedrive

**Pipedrive** (`api_key`): Sales CRM: deals, persons, organizations, activities and pipelines.

- **Settings:** `PIPEDRIVE_API_TOKEN`
- **What the key is:** A personal API token from Settings > Personal preferences > API in Pipedrive; the Gateway sends it in the x-api-token header. If API is missing there, an admin enables it for the person's permission set. Your personal API token from Settings > Personal preferences > API; it acts as you, and each company you belong to has its own.
- **Where the key comes from:** https://app.pipedrive.com/settings/api
- **API reference:** https://developers.pipedrive.com/docs/api/v1
- **How it is sent:** `x-api-token: <PIPEDRIVE_API_TOKEN>`, to `api.pipedrive.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `v1/users`, `v1/webhooks`, `v1/billing`, `v1/permissionsets`, `v1/roles`, `v1/usersettings`, `v1/userconnections`, `v1/legacyteams`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.pipedrive.com/v1/users/me`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** per call. Each endpoint spends API tokens from a daily company budget of 30,000 x plan multiplier (1 to 7) x seats.
- **Rate:** Per API token: 20 (Lite) to 120 (Ultimate) requests per 2 seconds; Search 10 per 2 seconds.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set PIPEDRIVE_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### airtable

**Airtable** (`api_key`): Bases, tables and records in the Airtable workspaces a token can reach.

- **Settings:** `AIRTABLE_API_TOKEN`
- **What the key is:** A personal access token from airtable.com/create/tokens, limited to the scopes and bases the app needs; the Gateway sends it as a bearer token. Listing records by POST (listRecords) needs write access; the GET form doesn't. A personal access token limited to the scopes and bases the app needs.
- **Where the key comes from:** https://airtable.com/create/tokens
- **API reference:** https://airtable.com/developers/web/api/introduction
- **How it is sent:** `Authorization: Bearer <AIRTABLE_API_TOKEN>`, to `api.airtable.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `v0/meta/whoami`, `v0/meta/enterpriseaccounts`, `v0/meta/workspaces`, `v0/meta/groups`, `v0/bases`, `scim`, `collaborators`, `invites`, `shares`, `blockinstallations`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.airtable.com/v0/meta/whoami`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 5 a second. 5 requests per second per base; 50 per second across all of one user's personal access tokens.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set AIRTABLE_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### notion

**Notion** (`api_key`): Pages, databases and blocks that a Notion connection has been given.

- **Settings:** `NOTION_API_TOKEN`
- **What the key is:** An internal connection's API token (a workspace owner creates the connection in Notion's developer portal), sent as a bearer token; it reaches only pages shared with it. The app sends the Notion-Version header itself. Search and data source queries are POSTs, so an app that queries needs write access. The API token on an internal connection's Configuration tab; share the pages it should reach with the connection.
- **Where the key comes from:** https://app.notion.com/developers/connections
- **API reference:** https://developers.notion.com/reference/intro
- **How it is sent:** `Authorization: Bearer <NOTION_API_TOKEN>`, to `api.notion.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `v1/users`, `v1/oauth`, `admin`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.notion.com/v1/users/me`, expecting 200; free. Send Notion-Version: 2026-03-11 with it; account-wide, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 180 a minute. Per connection: 180 a minute, 600 on Business and Enterprise; data source queries about 3 per second.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set NOTION_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### postmark

**Postmark** (`api_key`): Transactional email: single, batch and templated messages from one Postmark server.

- **Settings:** `POSTMARK_API_TOKEN`
- **What the key is:** A Server API token from the API Tokens tab of the Postmark server the app sends from; the Gateway sends it in the X-Postmark-Server-Token header. A Server API token from the server's API Tokens tab, never the Account API token.
- **Where the key comes from:** https://postmarkapp.com/support/article/1008-what-are-the-account-and-server-api-tokens
- **API reference:** https://postmarkapp.com/developer/api/overview
- **How it is sent:** `X-Postmark-Server-Token: <POSTMARK_API_TOKEN>`, to `api.postmarkapp.com` only, over https
- **What apps may do:** access `write`;  on any grant, and POST for an entry with `access: "write"`; account-wide paths refused: `server`, `servers`, `domains`, `senders`, `webhooks`, `message-streams`, `triggers`, `data-removals`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.postmarkapp.com/server`, expecting 200; free. Returns the server's settings; account-wide, so run it from a terminal.
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set POSTMARK_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### sendgrid

**SendGrid** (`api_key`): Twilio SendGrid email: send transactional and marketing mail through the v3 Mail Send API.

- **Settings:** `SENDGRID_API_KEY`
- **What the key is:** An API key from Settings > API Keys in SendGrid, sent as a bearer token; Custom Access with Mail Send alone is enough to send. EU regional subusers call api.eu.sendgrid.com. A Custom Access key with Mail Send only, never a Full Access key.
- **Where the key comes from:** https://app.sendgrid.com/settings/api_keys
- **API reference:** https://www.twilio.com/docs/sendgrid/api-reference
- **How it is sent:** `Authorization: Bearer <SENDGRID_API_KEY>`, to `api.sendgrid.com`, `api.eu.sendgrid.com` only, over https
- **What apps may do:** access `write`;  on any grant, and POST for an entry with `access: "write"`; account-wide paths refused: `api_keys`, `scopes`, `user`, `subusers`, `teammates`, `sso`, `access_settings`, `whitelabel`, `ips`, `send_ips`, `partners`, `partner_settings`, `alerts`, `mail_settings`, `tracking_settings`, `verified_senders`, `senders`, `marketing/integrations`, `recipients/erasejob`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.sendgrid.com/v3/scopes`, expecting 200; free. Lists the key's own scopes (the docs don't say whether a Mail-Send-only key may call it); account-wide, so run it from a terminal.
- **Cost:** not recorded
- **Rate:** Each endpoint has its own limit; answers carry X-RateLimit-Limit, -Remaining and -Reset.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set SENDGRID_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### twilio

**Twilio** (`api_key`): SMS, MMS and voice: send text messages and place calls from your Twilio numbers.

- **Settings:** `TWILIO_API_SECRET`, `TWILIO_API_KEY`
- **What the key is:** A Standard or Restricted API key from Account settings > API keys & auth tokens in the Twilio Console, sent as HTTP Basic (the key's SID and secret); a Standard key can't reach the Accounts or Keys resources. Every path names the account, so the app puts its Account SID in it: /2010-04-01/Accounts/<Account SID>/Messages.json, with a form-encoded body. TWILIO_API_SECRET: The API key's secret, shown once when the key is created. TWILIO_API_KEY: The SID of a Standard or Restricted API key, never a Main key or the Auth Token.
- **Where the key comes from:** https://www.twilio.com/docs/iam/api-keys/keys-in-console
- **API reference:** https://www.twilio.com/docs/usage/requests-to-twilio
- **How it is sent:** `Authorization: Basic base64(<TWILIO_API_KEY>:<TWILIO_API_SECRET>)`, to `api.twilio.com` only, over https
- **What apps may do:** access `write`;  on any grant, and POST for an entry with `access: "write"`; account-wide paths refused: `keys`, `signingkeys`, `incomingphonenumbers`, `outgoingcallerids`, `applications`, `connectapps`, `authorizedconnectapps`, `addresses`, `sip`, `usage`, `balance`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set TWILIO_API_SECRET TWILIO_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### intercom

**Intercom** (`api_key`): Customer messaging: contacts, companies, conversations, tickets and help center articles.

- **Settings:** `INTERCOM_API_TOKEN`
- **What the key is:** The Access Token of a private app in your workspace's Developer Hub, sent as a bearer token. Searching contacts, conversations or tickets is a POST, so an app that searches asks for write. The Access Token on your private app's Configure > Authentication page in the Developer Hub.
- **Where the key comes from:** https://app.intercom.com/a/apps/_/developer-hub
- **API reference:** https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis
- **How it is sent:** `Authorization: Bearer <INTERCOM_API_TOKEN>`, to `api.intercom.io`, `api.eu.intercom.io`, `api.au.intercom.io` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `me`, `admins`, `teams`, `export`, `download`, `ip_allowlist`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.intercom.io/me`, expecting 200; free. Returns the admin behind the token; account-wide, so run it from a terminal.
- **Cost:** not recorded
- **Rate:** 10000 a minute. Per workspace, shared by its private apps; 25,000 a minute across all apps; counted in 10-second windows.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set INTERCOM_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### crisp

**Crisp** (`api_key`): Customer chat: conversations, messages, people and visitors of one Crisp workspace.

- **Settings:** `CRISP_API_KEY`, `CRISP_API_IDENTIFIER`
- **What the key is:** A website token, which the workspace owner generates under Settings > Workspace Settings > Advanced configuration > API Token. The Gateway sends the identifier and key as HTTP Basic; the app sends X-Crisp-Tier: website on every call. CRISP_API_KEY: The token's key, shown once when the workspace owner generates it. CRISP_API_IDENTIFIER: The token's identifier, shown beside the key.
- **Where the key comes from:** https://docs.crisp.chat/guides/rest-api/authentication/website-token/
- **API reference:** https://docs.crisp.chat/references/rest-api/v1/
- **How it is sent:** `Authorization: Basic base64(<CRISP_API_IDENTIFIER>:<CRISP_API_KEY>)`, to `api.crisp.chat` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `operators`, `operator`, `teams`, `team`, `settings`, `verify`, `audit`, `plans`, `plugins`, `plugin`, `connect`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** 10000 a day. The website token's daily quota.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set CRISP_API_KEY CRISP_API_IDENTIFIER`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### linear

**Linear** (`api_key`): Issue tracking over GraphQL: issues, projects, cycles, comments and teams.

- **Settings:** `LINEAR_API_KEY`
- **What the key is:** A personal API key from Settings > Account > Security & access; the Gateway sends it as the Authorization header with no Bearer word. Every call is a POST to /graphql, queries included, so the app asks for write. A personal API key, restricted to the permissions and teams the app needs.
- **Where the key comes from:** https://linear.app/settings/account/security
- **API reference:** https://linear.app/developers/graphql
- **How it is sent:** `Authorization: <LINEAR_API_KEY>`, to `api.linear.app` only, over https
- **What apps may do:** access `write`;  on any grant, and POST for an entry with `access: "write"`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** 2,500 requests and 3,000,000 complexity points an hour per API key.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set LINEAR_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### github

**GitHub** (`api_key`): Code hosting: repositories, issues, pull requests, Actions and releases through the REST API.

- **Settings:** `GITHUB_API_TOKEN`
- **What the key is:** A fine-grained personal access token from Settings > Developer settings, limited to one owner, the repositories the app needs and the least permissions; sent as a bearer token. GraphQL is a POST to /graphql, so it needs write. A fine-grained personal access token limited to the repositories and permissions the app needs.
- **Where the key comes from:** https://github.com/settings/personal-access-tokens/new
- **API reference:** https://docs.github.com/en/rest
- **How it is sent:** `Authorization: Bearer <GITHUB_API_TOKEN>`, to `api.github.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `user/email`, `user/emails`, `user/public_emails`, `user/gpg_keys`, `user/ssh_signing_keys`, `user/social_accounts`, `keys`, `hooks`, `secrets`, `members`, `memberships`, `invitations`, `failed_invitations`, `collaborators`, `outside_collaborators`, `blocks`, `installations`, `personal-access-tokens`, `personal-access-token-requests`, `credential-authorizations`, `audit-log`, `billing`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.github.com/user`, expecting 200; free. Returns the token's owner; 401 means the token is wrong.
- **Cost:** not recorded
- **Rate:** 5,000 requests an hour per token; at most 100 concurrent requests and 900 points a minute across REST endpoints.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set GITHUB_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### gitlab

**GitLab** (`api_key`): Code hosting on GitLab.com: projects, issues, merge requests, pipelines and releases.

- **Settings:** `GITLAB_API_TOKEN`
- **What the key is:** A personal, project or group access token from GitLab.com, sent in the PRIVATE-TOKEN header; read_api is enough to read. Paths start with /api/v4. A self-managed GitLab needs its own registered provider. A personal, project or group access token with read_api, or api when the app writes.
- **Where the key comes from:** https://gitlab.com/-/user_settings/personal_access_tokens
- **API reference:** https://docs.gitlab.com/api/rest/
- **How it is sent:** `PRIVATE-TOKEN: <GITLAB_API_TOKEN>`, to `gitlab.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `user`, `personal_access_tokens`, `access_tokens`, `deploy_tokens`, `deploy_keys`, `project_deploy_keys`, `hooks`, `members`, `pending_members`, `billable_members`, `invitations`, `variables`, `audit_events`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://gitlab.com/api/v4/personal_access_tokens/self`, expecting 200; free. Describes a personal access token itself (401 when it is wrong or revoked); account-wide, so run it from a terminal.
- **Cost:** not recorded
- **Rate:** 2000 a minute. Authenticated API traffic per user on GitLab.com.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set GITLAB_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### vercel

**Vercel** (`api_key`): Frontend hosting: projects, deployments, domains and logs through the Vercel REST API.

- **Settings:** `VERCEL_API_TOKEN`
- **What the key is:** An access token from your account's Tokens page, sent as a bearer token; scope it to one team or one project. A team- or project-scoped token needs no teamId parameter. An access token scoped to one team or one project, never Full Account.
- **Where the key comes from:** https://vercel.com/account/tokens
- **API reference:** https://vercel.com/docs/rest-api
- **How it is sent:** `Authorization: Bearer <VERCEL_API_TOKEN>`, to `api.vercel.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `user`, `teams`, `members`, `organizations`, `access-groups`, `billing`, `webhooks`, `drains`, `env`, `v3/events`, `v1/events`, `v1/integrations`, `installations`, `connect`, `kms`, `api-keys`, `ai-gateway`, `token`, `tokens`, `registrar`, `transfer-request`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.vercel.com/v10/projects`, expecting 200; free. Lists the projects the token can reach.
- **Cost:** not recorded
- **Rate:** Limits are per action (deployments, domains, teams), listed on Vercel's limits page.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set VERCEL_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### cloudflare

**Cloudflare** (`api_key`): Cloudflare's API: zones, DNS, Workers, R2, D1, KV and the rest of an account.

- **Settings:** `CLOUDFLARE_PROVIDER_API_TOKEN`
- **What the key is:** An API token from My Profile > API Tokens with only the permissions the app needs; the Gateway sends it as a bearer token. A token on the Gateway's own account can read and change the Gateway, so keep it narrow or use another account. A user or account-owned API token scoped to the zones and permissions the app needs, never a Global API Key.
- **Where the key comes from:** https://dash.cloudflare.com/profile/api-tokens
- **API reference:** https://developers.cloudflare.com/api/
- **How it is sent:** `Authorization: Bearer <CLOUDFLARE_PROVIDER_API_TOKEN>`, to `api.cloudflare.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `client/v4/user`, `client/v4/memberships`, `client/v4/organizations`, `client/v4/tenants`, `members`, `tokens`, `roles`, `iam`, `subscriptions`, `payment-methods`, `pay-invoice`, `receipts`, `invoices`, `client-secret`, `billing`, `logs/audit`, `audit_logs`, `alerting/v3/destinations/webhooks`, `ai/run`, `ai/v1`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.cloudflare.com/client/v4/user/tokens/verify`, expecting 200; free. For a user token; account-owned tokens use /client/v4/accounts/<id>/tokens/verify. Account-wide, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 1,200 requests per 5 minutes per user or account token; 200 a second per IP; GraphQL by query cost, at most 320 per 5 minutes.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set CLOUDFLARE_PROVIDER_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### posthog

**PostHog** (`api_key`): Product analytics: insights, feature flags, persons, cohorts, experiments and HogQL queries.

- **Settings:** `POSTHOG_PERSONAL_API_KEY`
- **What the key is:** A personal API key from Settings > Personal API keys, with only the scopes the app needs; the Gateway sends it as a bearer token to us.posthog.com or eu.posthog.com. HogQL queries are POSTs, so an app that runs them asks for write. A personal API key (phx_...) with only the scopes the app needs, from the region the project lives in; never the project token.
- **Where the key comes from:** https://us.posthog.com/settings/user-api-keys
- **API reference:** https://posthog.com/docs/api
- **How it is sent:** `Authorization: Bearer <POSTHOG_PERSONAL_API_KEY>`, to `us.posthog.com`, `eu.posthog.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `api/users`, `api/user`, `api/organizations`, `api/billing`, `api/revoke_leaked_key`, `project_secret_api_keys`, `billing`, `activity_log`, `advanced_activity_logs`, `hog_functions`, `batch_exports`, `integrations`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://us.posthog.com/api/users/@me/`, expecting 200; free. Needs the user:read scope; use eu.posthog.com for an EU project. Account-wide, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 480 a minute. Create, read, update and delete endpoints 480 a minute and 4,800 an hour; analytics endpoints 240 a minute; the query endpoint 2,400 an hour.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set POSTHOG_PERSONAL_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### mixpanel

**Mixpanel** (`api_key`): Product analytics: saved reports, profiles, raw event export and event import.

- **Settings:** `MIXPANEL_SERVICE_ACCOUNT_SECRET`, `MIXPANEL_SERVICE_ACCOUNT_USERNAME`
- **What the key is:** A service account from Organization Settings > Service Accounts; the Gateway sends its username and secret as HTTP Basic. Most calls also need the project_id parameter, and an EU or India project uses its own hosts. MIXPANEL_SERVICE_ACCOUNT_USERNAME: The service account's username, shown when it is created in Organization Settings > Service Accounts. MIXPANEL_SERVICE_ACCOUNT_SECRET: The service account's secret, shown once when it is created; give the account the narrowest role and only the projects the app needs.
- **Where the key comes from:** https://mixpanel.com/settings/org#serviceaccounts
- **API reference:** https://docs.mixpanel.com/reference/overview
- **How it is sent:** `Authorization: Basic base64(<MIXPANEL_SERVICE_ACCOUNT_USERNAME>:<MIXPANEL_SERVICE_ACCOUNT_SECRET>)`, to `mixpanel.com`, `eu.mixpanel.com`, `in.mixpanel.com`, `data.mixpanel.com`, `data-eu.mixpanel.com`, `data-in.mixpanel.com`, `api.mixpanel.com`, `api-eu.mixpanel.com`, `api-in.mixpanel.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `api/app/me`, `api/app/organizations`, `service-accounts`, `data-retrievals`, `data-deletions`, `nessie`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://mixpanel.com/api/app/me`, expecting 200; free. Lists the organizations and projects the service account reaches. Account-wide, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** Per project: Query API 60 queries an hour, 5 at once; Raw Data Export 60 an hour, 3 a second, 100 at once; ingestion about 2 GB a minute.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set MIXPANEL_SERVICE_ACCOUNT_SECRET MIXPANEL_SERVICE_ACCOUNT_USERNAME`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### segment

**Segment** (`api_key`): Sends identify, track, page, group and alias events to a Segment source.

- **Settings:** `SEGMENT_WRITE_KEY`
- **What the key is:** The write key of an HTTP API source, from the source's Settings > API Keys; the Gateway sends it as the Basic username with an empty password. It only sends events; an EU workspace uses events.eu1.segmentapis.com. The write key of an HTTP API source, from the source's Settings > API Keys.
- **Where the key comes from:** https://www.twilio.com/docs/segment/connections/find-writekey
- **API reference:** https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/http-api
- **How it is sent:** `Authorization: Basic base64(<SEGMENT_WRITE_KEY>:)`, to `api.segment.io`, `events.eu1.segmentapis.com` only, over https
- **What apps may do:** access `write`;  on any grant, and POST for an entry with `access: "write"`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** 1000 a second. Recommended ceiling per workspace; 32 KB per call, 500 KB and 2,500 events per batch.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set SEGMENT_WRITE_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### supabase

**Supabase** (`api_key`): A Supabase project's Postgres REST API and Storage, with its secret key.

- **Settings:** `SUPABASE_SECRET_KEY`, `SUPABASE_HOST`
- **What the key is:** A secret key (sb_secret_...) from Settings > API Keys and the project's host; the Gateway sends the key in the apikey header. The key bypasses Row Level Security, and RPC calls are POSTs, so they need write. SUPABASE_SECRET_KEY: A secret key (sb_secret_...) from Settings > API Keys, made for this Gateway alone; it bypasses Row Level Security. SUPABASE_HOST: The project's host, <project-ref>.supabase.co, from the project URL.
- **Where the key comes from:** https://supabase.com/dashboard/project/_/settings/api-keys
- **API reference:** https://supabase.com/docs/guides/api
- **How it is sent:** `apikey: <SUPABASE_SECRET_KEY>`, to the host `<SUPABASE_HOST>` names (a bare host or an https origin) only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `auth/v1/admin`, `pg`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://<SUPABASE_HOST>/rest/v1/`, expecting 200; free. The REST API's OpenAPI root, which only a secret key may read; sent to the host in SUPABASE_HOST.
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set SUPABASE_SECRET_KEY SUPABASE_HOST`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### turso

**Turso** (`api_key`): Turso's Platform API: databases, groups, locations and usage for one organization.

- **Settings:** `TURSO_API_TOKEN`
- **What the key is:** An organization-scoped Platform API token (turso auth api-tokens mint <name> --org <org>); the Gateway sends it as a bearer token to api.turso.tech. It manages databases and cannot query them: that is the turso-db entry. An organization-scoped or group-scoped Platform API token from turso auth api-tokens mint <name> --org <org>; never an unrestricted one.
- **Where the key comes from:** https://docs.turso.tech/api-reference/authentication
- **API reference:** https://docs.turso.tech/api-reference/introduction
- **How it is sent:** `Authorization: Bearer <TURSO_API_TOKEN>`, to `api.turso.tech` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `auth`, `api-tokens`, `members`, `invites`, `invoices`, `subscription`, `plans`, `audit-logs`, `v1/user`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.turso.tech/v1/auth/validate`, expecting 200; free. Account-wide, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set TURSO_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### turso-db

**Turso database** (`api_key`): SQL over HTTP to one Turso database: queries, dumps and migration status.

- **Settings:** `TURSO_DB_AUTH_TOKEN`, `TURSO_DB_HOST`
- **What the key is:** A database token (turso db tokens create <db>) and the database's HTTP host; the Gateway sends the token as a bearer token. Every query is a POST to /v2/pipeline, so an app that queries asks for write; a --read-only token keeps it to reads. TURSO_DB_AUTH_TOKEN: A database token from turso db tokens create <db>, with --read-only or fine-grained permissions when the app only reads. TURSO_DB_HOST: The database's HTTP host, <db>-<org>.turso.io, from turso db show <db> --http-url.
- **Where the key comes from:** https://docs.turso.tech/sdk/authorization/tokens
- **API reference:** https://docs.turso.tech/sdk/http/reference
- **How it is sent:** `Authorization: Bearer <TURSO_DB_AUTH_TOKEN>`, to the host `<TURSO_DB_HOST>` names (a bare host or an https origin) only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST for an entry with `access: "write"`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set TURSO_DB_AUTH_TOKEN TURSO_DB_HOST`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### neon

**Neon** (`api_key`): Neon's management API: Postgres projects, branches, databases, roles and endpoints.

- **Settings:** `NEON_API_KEY`
- **What the key is:** A project-scoped or organization API key from Settings > API keys; the Gateway sends it as a bearer token to console.neon.tech. It manages projects and branches; the database itself takes Postgres credentials, not this key. A project-scoped or organization API key from Settings > API keys; a project-scoped key reaches one project only.
- **Where the key comes from:** https://neon.com/docs/manage/api-keys
- **API reference:** https://neon.com/docs/reference/api
- **How it is sent:** `Authorization: Bearer <NEON_API_KEY>`, to `console.neon.tech` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `api/v2/auth`, `api/v2/organizations`, `users/me`, `api_keys`, `members`, `invitations`, `permissions`, `transfer_requests`, `billing`, `consumption_history`, `connection_uri`, `reveal_password`, `reset_password`, `credentials`, `realtime/secret`, `rotate_secret`, `auth/keys`, `auth/webhooks`, `oauth_providers`, `email_server`, `email_provider`, `auth/plugins`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://console.neon.tech/api/v2/auth`, expecting 200; free. Says which credential and identity the key is. Account-wide, so run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 700 a minute. About 11 a second, with bursts of 40 a second per route.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set NEON_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### pinecone

**Pinecone** (`api_key`): Vector database: indexes, namespaces, vectors and documents, plus hosted embedding and rerank.

- **Settings:** `PINECONE_API_KEY`, `PINECONE_HOST`
- **What the key is:** An API key from the project's API keys page and the host of the index the app uses; the Gateway sends the key in the Api-Key header to api.pinecone.io and that host. Query, search, embed and rerank are POSTs, so an app that uses them asks for write. PINECONE_API_KEY: An API key from the project's API keys page in the Pinecone console. PINECONE_HOST: The host of the index the app uses, <index>-<id>.svc.<env>.pinecone.io, from describe_index or the console.
- **Where the key comes from:** https://app.pinecone.io/organizations/-/projects/-/keys
- **API reference:** https://docs.pinecone.io/reference/api/introduction
- **How it is sent:** `Api-Key: <PINECONE_API_KEY>`, to `api.pinecone.io`, the host `<PINECONE_HOST>` names (a bare host or an https origin) only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `admin`, `api-keys`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.pinecone.io/indexes`, expecting 200; free. Lists the project's indexes; the app sends X-Pinecone-Api-Version itself.
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set PINECONE_API_KEY PINECONE_HOST`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### mapbox

**Mapbox** (`api_key`): Maps and location: geocoding, directions, styles, tilesets and datasets.

- **Settings:** `MAPBOX_ACCESS_TOKEN`
- **What the key is:** An access token from Access tokens in the Mapbox console, with only the scopes the app needs; the Gateway adds it to every call as the access_token parameter. An access token with only the scopes the app needs, from Access tokens in the Mapbox console.
- **Where the key comes from:** https://console.mapbox.com/account/access-tokens/
- **API reference:** https://docs.mapbox.com/api/overview/
- **How it is sent:** `?access_token=<MAPBOX_ACCESS_TOKEN>` on the URL, in place of any the app sent, to `api.mapbox.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, PATCH, DELETE for an entry with `access: "write"`; account-wide paths refused: `tokens`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** Per token and per API: Geocoding 1,000 a minute, Directions 300, Static Images 1,250; the Tokens API 100 a minute per account.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set MAPBOX_ACCESS_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### openweather

**OpenWeather** (`api_key`): Weather data: current conditions, forecasts, One Call, history and weather map tiles.

- **Settings:** `OPENWEATHER_API_KEY`
- **What the key is:** An API key from the API keys tab of your OpenWeather account; the Gateway adds it to every call as the appid parameter. Paid products (hourly forecast, history, Weather Maps 2.0) need a plan that includes them. An API key from the API keys tab of the OpenWeather account; a new key can take up to two hours to activate.
- **Where the key comes from:** https://home.openweathermap.org/api_keys
- **API reference:** https://openweathermap.org/api
- **How it is sent:** `?appid=<OPENWEATHER_API_KEY>` on the URL, in place of any the app sent, to `api.openweathermap.org`, `pro.openweathermap.org`, `history.openweathermap.org`, `tile.openweathermap.org`, `maps.openweathermap.org` only, over https
- **What apps may do:** access `read`; GET, HEAD on any grant; account-wide paths refused: `data/3/stations`, `data/3/measurements`; data `per-call`
- **Smoke request:** `GET https://api.openweathermap.org/data/2.5/weather?lat=51.51&lon=-0.13`, expecting 200; free. Counts one call against the plan's quota; free within it. A bad or not yet active key answers 401.
- **Cost:** per call. One Call API 3.0 includes 1,000 calls a day free, then is paid per call.
- **Rate:** 60 a minute. The Free plan answers 429 past 60 calls a minute.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set OPENWEATHER_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### voyage

**Voyage AI** (`api_key`): Embeddings and rerankers for search and retrieval: text, code, multimodal, contextualized chunks.

- **Settings:** `VOYAGE_API_KEY`
- **What the key is:** A secret key from the Voyage dashboard; the Gateway sends it as a bearer token. Apps POST to /v1/embeddings, /v1/multimodalembeddings, /v1/contextualizedembeddings and /v1/rerank. A secret key from API keys in the Voyage dashboard.
- **Where the key comes from:** https://dashboard.voyageai.com/organization/api-keys
- **API reference:** https://docs.voyageai.com/reference/embeddings-api
- **How it is sent:** `Authorization: Bearer <VOYAGE_API_KEY>`, to `api.voyageai.com` only, over https
- **What apps may do:** access `read`; POST on any grant; account-wide paths refused: `v1/files`, `v1/batches`; data `per-call`
- **Smoke request:** `GET https://api.voyageai.com/v1/batches`, expecting 200; free. Lists the organization's batches, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** per token. voyage-4 $0.06 per million tokens; the first 200 million tokens of the voyage-4 family are free per account.
- **Rate:** 2000 a minute. 2,000 requests a minute at tier 1, doubled at tier 2, tripled at tier 3; tokens per minute vary by model.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set VOYAGE_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### perplexity

**Perplexity** (`api_key`): Web-grounded answers from the Agent API, raw web search results, and embeddings.

- **Settings:** `PERPLEXITY_API_KEY`
- **What the key is:** An API key from the Perplexity console; the Gateway sends it as a bearer token. Apps POST to /v1/agent for researched answers and /search for result lists, and GET /v1/agent/{id} to poll a background run. An API key from the project's API keys page in the Perplexity console.
- **Where the key comes from:** https://console.perplexity.ai/project/keys
- **API reference:** https://docs.perplexity.ai/api-reference/agent-post
- **How it is sent:** `Authorization: Bearer <PERPLEXITY_API_KEY>`, to `api.perplexity.ai` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; account-wide paths refused: `v1/batches`, `v1/files`, `v1/skills`, `v1/analytics`, `v2/analytics`, `generate_auth_token`, `revoke_auth_token`; data `per-call`
- **Smoke request:** `GET https://api.perplexity.ai/orchestrator/v1/models`, expecting 200; free
- **Cost:** per token. Agent API per token plus tool fees (web_search $0.0025 a call); Search API $5 per 1,000 requests.
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set PERPLEXITY_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### jina

**Jina AI** (`api_key`): Reads web pages as Markdown, searches the web, and embeds and reranks text and images.

- **Settings:** `JINA_API_KEY`
- **What the key is:** An API key from the Jina API dashboard; the Gateway sends it as a bearer token. Reader is r.jina.ai (POST {"url": ...}), Search is s.jina.ai, and embeddings and rerank are on api.jina.ai. A key starting jina_, from Manage API Key in the Jina API dashboard.
- **Where the key comes from:** https://jina.ai/api-dashboard/key-manager
- **API reference:** https://docs.jina.ai/
- **How it is sent:** `Authorization: Bearer <JINA_API_KEY>`, to `api.jina.ai`, `r.jina.ai`, `s.jina.ai` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; account-wide paths refused: `v1/batches`, `echo`; data `per-call`
- **Smoke request:** `GET https://api.jina.ai/v1/batches`, expecting 200; free. Lists the account's batch jobs, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** per token. Billed in tokens against the account balance; GET /v1/models lists each model's price.
- **Rate:** Reader 500 requests a minute, Search 100, embeddings and rerank 500; premium keys get ten times more.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set JINA_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### replicate

**Replicate** (`api_key`): Runs open-source and official models by API: images, video, audio and language.

- **Settings:** `REPLICATE_API_TOKEN`
- **What the key is:** An API token from Replicate's API tokens page; the Gateway sends it as a bearer token. Apps POST to /v1/models/{owner}/{name}/predictions or /v1/predictions with Prefer: wait (up to 60 seconds), or pass a webhook URL for longer runs. An API token from the API tokens page of the Replicate account.
- **Where the key comes from:** https://replicate.com/account/api-tokens
- **API reference:** https://replicate.com/docs/reference/http
- **How it is sent:** `Authorization: Bearer <REPLICATE_API_TOKEN>`, to `api.replicate.com` only, over https
- **What apps may do:** access `read`; POST on any grant; account-wide paths refused: `v1/account`, `v1/deployments`, `v1/files`, `v1/webhooks`, `trainings`; data `per-call`
- **Smoke request:** `GET https://api.replicate.com/v1/account`, expecting 200; free. Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 600 a minute. Creating predictions 600 a minute; every other endpoint 3,000 a minute.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set REPLICATE_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### huggingface

**Hugging Face Inference** (`api_key`): Open models from Hugging Face's inference providers through one router: chat, embeddings, images, speech.

- **Settings:** `HUGGINGFACE_API_TOKEN`
- **What the key is:** A fine-grained access token from Hugging Face settings with the Inference Providers permission; the Gateway sends it as a bearer token. Apps POST OpenAI-style chat to /v1/chat/completions, or other tasks under /<provider>/, such as /hf-inference/models/<model>. A fine-grained token with only the Make calls to Inference Providers permission.
- **Where the key comes from:** https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained
- **API reference:** https://huggingface.co/docs/inference-providers/index
- **How it is sent:** `Authorization: Bearer <HUGGINGFACE_API_TOKEN>`, to `router.huggingface.co` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; data `per-call`
- **Smoke request:** none recorded
- **Cost:** per call. Pay as you go at each provider's own rate with no markup; PRO accounts get $2 of compute credits a month.
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set HUGGINGFACE_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### firecrawl

**Firecrawl** (`api_key`): Scrapes, crawls, maps and searches the web, returning clean markdown or structured data.

- **Settings:** `FIRECRAWL_API_KEY`
- **What the key is:** An API key from Firecrawl's API keys page; the Gateway sends it as a bearer token. Scrape, crawl, map, search and extract are POSTs and job status is a GET; cancelling a crawl or batch (DELETE) needs write. An API key from Firecrawl's API keys page; it starts with fc-.
- **Where the key comes from:** https://www.firecrawl.dev/app/api-keys
- **API reference:** https://docs.firecrawl.dev/api-reference/introduction
- **How it is sent:** `Authorization: Bearer <FIRECRAWL_API_KEY>`, to `api.firecrawl.dev` only, over https
- **What apps may do:** access `read`, `write`; GET, POST on any grant, and DELETE for an entry with `access: "write"`; account-wide paths refused: `team`, `crawl/active`, `monitor`, `agent`, `interact`, `support/ask`; data `per-call`
- **Smoke request:** `GET https://api.firecrawl.dev/v2/team/credit-usage`, expecting 200; free. Remaining credits; account-wide, so the Gateway refuses it for apps: run it from the person's terminal.
- **Cost:** per result. Credits: 1 per page scraped or crawled, 1 per map call, 2 per 10 search results; JSON extraction and other options add more.
- **Rate:** Per team per minute, by plan: /scrape 10 on Free, 100 Hobby, 500 Standard, 5,000 Growth; /crawl 2, 20, 100, 1,000.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set FIRECRAWL_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### exa

**Exa** (`api_key`): Web search built for AI: search results, page contents, similar links and cited answers.

- **Settings:** `EXA_API_KEY`
- **What the key is:** An API key from the Exa dashboard (the free tier gives $10 of credit a month); the Gateway sends it in the x-api-key header. Search, contents, find-similar and answer are POSTs. An API key from the API keys page of the Exa dashboard.
- **Where the key comes from:** https://dashboard.exa.ai/api-keys
- **API reference:** https://exa.ai/docs/reference/search
- **How it is sent:** `x-api-key: <EXA_API_KEY>`, to `api.exa.ai` only, over https
- **What apps may do:** access `read`; POST on any grant; account-wide paths refused: `websets`, `monitors`, `agent`, `batches`; data `per-call`
- **Smoke request:** `GET https://api.exa.ai/websets/v0/teams/me`, expecting 200; free. Team info under the Websets API (the docs page leaves out the /websets prefix); account-wide, so run it from the person's terminal.
- **Cost:** per call, $0.007. Search $7 per 1k (auto and fast; lite $4), contents $1 per 1k pages, answer $5 per 1k; up to 10 results included.
- **Rate:** 10 a second. Per team: /search and /answer 10 QPS, deep search 5, /contents 100.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set EXA_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### tavily

**Tavily** (`api_key`): Web search, page extraction, crawling and site maps for AI agents, plus research reports.

- **Settings:** `TAVILY_API_KEY`
- **What the key is:** An API key from app.tavily.com (1,000 free credits a month); the Gateway sends it as a bearer token. Search, extract, crawl, map and research are POSTs; a research result is a GET. An API key from the Tavily dashboard; it starts with tvly-.
- **Where the key comes from:** https://app.tavily.com
- **API reference:** https://docs.tavily.com/documentation/api-reference/endpoint/search
- **How it is sent:** `Authorization: Bearer <TAVILY_API_KEY>`, to `api.tavily.com` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; account-wide paths refused: `usage`, `logs`, `org-usage`; data `per-call`
- **Smoke request:** `GET https://api.tavily.com/usage`, expecting 200; free. Key and account usage, not an endpoint that costs credits; account-wide, so run it from the person's terminal (10 calls per 10 minutes).
- **Cost:** per call, $0.008. Pay as you go $0.008 per credit: basic search 1 credit, advanced 2; extract 1 credit per 5 URLs; map 1 per 10 pages.
- **Rate:** 100 a minute. Development keys 100 per minute, production keys 1,000; crawl 100 and research 20 per minute for both.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set TAVILY_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### serper

**Serper** (`api_key`): Google search results as JSON: web, news, images, places, shopping, scholar and patents.

- **Settings:** `SERPER_API_KEY`
- **What the key is:** An API key from serper.dev (2,500 free queries to start); the Gateway sends it in the X-API-KEY header. Every search is a POST to google.serper.dev/<type> (search, news, images, places, …) with a JSON body such as {"q": "…"}. The API key on serper.dev's API keys page.
- **Where the key comes from:** https://serper.dev/api-keys
- **API reference:** https://serper.dev/playground
- **How it is sent:** `X-API-KEY: <SERPER_API_KEY>`, to `google.serper.dev`, `scrape.serper.dev` only, over https
- **What apps may do:** access `read`; POST on any grant; data `per-call`
- **Smoke request:** none recorded
- **Cost:** per call, $0.001. Prepaid credits, one per successful query: $1.00 per 1k on the 50k pack, down to $0.30 per 1k on the largest.
- **Rate:** 50 a second. Starter credits 50 queries per second; Standard 100, Scale 200, Ultimate 300.
- **Verified:** no: not checked against the provider's docs
- **Set it:** `pnpm everyapp secret set SERPER_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### brave-search

**Brave Search** (`api_key`): Brave's independent web index: web, news, images, videos, places, LLM context and answers.

- **Settings:** `BRAVE_SEARCH_API_KEY`
- **What the key is:** Activate a plan (it includes $5 of free credit a month), then create a key under API Keys; the Gateway sends it in the X-Subscription-Token header. Searches are GETs (POST works too); answers are a POST to /res/v1/chat/completions. A key from the API Keys section of the Brave Search API dashboard, made after activating a plan.
- **Where the key comes from:** https://api-dashboard.search.brave.com/app/keys
- **API reference:** https://api-dashboard.search.brave.com/documentation
- **How it is sent:** `X-Subscription-Token: <BRAVE_SEARCH_API_KEY>`, to `api.search.brave.com` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; data `per-call`
- **Smoke request:** none recorded
- **Cost:** per call, $0.005. Search $5 per 1k requests; Answers $4 per 1k plus $5 per million tokens; $5 free credit a month; only successful calls count.
- **Rate:** 50 a second. Search plan 50 queries per second; Answers 2 per second.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set BRAVE_SEARCH_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### apify

**Apify** (`api_key`): Runs Apify Actors (ready-made scrapers and automations) and reads their datasets and stores.

- **Settings:** `APIFY_API_TOKEN`
- **What the key is:** The API token from Apify Console, Settings > API & Integrations; the Gateway sends it as a bearer token. Reading Actors, runs and datasets needs read; starting a run is a POST, so it needs write. The API token under Settings > API & Integrations in Apify Console.
- **Where the key comes from:** https://console.apify.com/settings/integrations
- **API reference:** https://docs.apify.com/api/v2
- **How it is sent:** `Authorization: Bearer <APIFY_API_TOKEN>`, to `api.apify.com` only, over https
- **What apps may do:** access `read`, `write`; GET, HEAD on any grant, and POST, PUT, DELETE for an entry with `access: "write"`; account-wide paths refused: `users`, `webhooks`, `webhook-dispatches`, `env-vars`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.apify.com/v2/users/me`, expecting 200; free. The docs' verify call; account-wide, so the Gateway refuses it for apps: run it from the person's terminal.
- **Cost:** not recorded
- **Rate:** 60 a second. 60 requests per second per resource (one Actor, run, dataset or store); 250,000 requests per minute per user overall.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set APIFY_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### deepgram

**Deepgram** (`api_key`): Speech to text, text to speech and text analysis.

- **Settings:** `DEEPGRAM_API_KEY`
- **What the key is:** An API key from the Deepgram Console; the Gateway sends it as Authorization: Token <key>, and the EU, Australia and India hosts take the same key. Transcription (/v1/listen), speech (/v1/speak) and text analysis (/v1/read) are POSTs. A project API key created in the Deepgram Console.
- **Where the key comes from:** https://console.deepgram.com/
- **API reference:** https://developers.deepgram.com/reference/deepgram-api-overview
- **How it is sent:** `Authorization: Token <DEEPGRAM_API_KEY>`, to `api.deepgram.com`, `api.eu.deepgram.com`, `api.au.deepgram.com`, `api.in.deepgram.com` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; account-wide paths refused: `projects`, `auth/grant`; data `per-call`
- **Smoke request:** `GET https://api.deepgram.com/v1/models`, expecting 200; free. Lists the public models; it needs the key and processes no audio.
- **Cost:** per call. Nova-3 pre-recorded $0.0043 per audio minute (pay as you go); Aura-2 speech $0.030 per 1k characters; $200 free credit.
- **Rate:** Concurrency per project on pay as you go: 50 pre-recorded transcriptions, 15 text-to-speech requests.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set DEEPGRAM_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### elevenlabs

**ElevenLabs** (`api_key`): Text to speech, speech to text, sound effects, music and voice changing.

- **Settings:** `ELEVENLABS_API_KEY`
- **What the key is:** An API key from ElevenLabs' API keys page; the Gateway sends it in the xi-api-key header. Speech, transcription and sound generation are POSTs; listing voices and models are GETs. An API key from ElevenLabs' API keys page; it can be scoped to the endpoints the app uses and given a credit cap.
- **Where the key comes from:** https://elevenlabs.io/app/settings/api-keys
- **API reference:** https://elevenlabs.io/docs/api-reference/introduction
- **How it is sent:** `xi-api-key: <ELEVENLABS_API_KEY>`, to `api.elevenlabs.io` only, over https
- **What apps may do:** access `read`; GET, POST on any grant; account-wide paths refused: `v1/user`, `v1/usage`, `v1/workspace`, `v1/workspaces`, `v1/service-accounts`, `v1/history`, `v1/single-use-token`, `v1/convai`, `v1/dubbing`, `v1/studio`, `v1/pronunciation-dictionaries`, `v1/voices/add`, `v1/voices/pvc`, `v1/voices/collections`, `edit`, `replicate-to-isolated-environment`, `v1/text-to-voice`, `v1/audio-native`, `v1/productions`, `v1/speech-engine`, `v1/music/finetunes`, `v1/flows`, `v1/assets`, `v1/audio-isolation/history`; data `per-call`
- **Smoke request:** `GET https://api.elevenlabs.io/v1/models`, expecting 200; free. The first request in ElevenLabs' authentication docs; it generates nothing.
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set ELEVENLABS_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### assemblyai

**AssemblyAI** (`api_key`): Transcribes recorded audio and video, with speaker labels, redaction and subtitles.

- **Settings:** `ASSEMBLYAI_API_KEY`
- **What the key is:** The API key from your AssemblyAI dashboard; the Gateway sends it as the whole Authorization header, with no Bearer word. Audio is submitted with a POST to /v2/transcript and the app polls GET /v2/transcript/<id>; deleting a transcript needs write. The API key on your AssemblyAI dashboard.
- **Where the key comes from:** https://www.assemblyai.com/dashboard/home
- **API reference:** https://www.assemblyai.com/docs
- **How it is sent:** `Authorization: <ASSEMBLYAI_API_KEY>`, to `api.assemblyai.com`, `api.eu.assemblyai.com` only, over https
- **What apps may do:** access `read`, `write`; GET, POST on any grant, and DELETE for an entry with `access: "write"`; data `account` (served on a self-hosted Gateway only)
- **Smoke request:** `GET https://api.assemblyai.com/v2/transcript?limit=1`, expecting 200; free. Lists the account's latest transcript; it transcribes nothing.
- **Cost:** per call. Per hour of audio submitted: Universal-3.5 Pro $0.21, Universal-2 $0.15; the free tier covers up to 185 hours of pre-recorded audio.
- **Rate:** 4000 a minute. 20,000 requests per 5 minutes per account; 5 transcriptions in parallel on free accounts, 200 or more on paid.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set ASSEMBLYAI_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### newsapi

**NewsAPI** (`api_key`): Searches news articles and live headlines from over 150,000 sources.

- **Settings:** `NEWSAPI_API_KEY`
- **What the key is:** An API key from newsapi.org/register; the Gateway sends it in the X-Api-Key header. The free Developer plan allows 100 requests a day, delays articles by 24 hours and is for development only; production needs a paid plan. The API key NewsAPI shows after you register.
- **Where the key comes from:** https://newsapi.org/register
- **API reference:** https://newsapi.org/docs
- **How it is sent:** `X-Api-Key: <NEWSAPI_API_KEY>`, to `newsapi.org` only, over https
- **What apps may do:** access `read`; GET on any grant; data `per-call`
- **Smoke request:** none recorded
- **Cost:** per call, $0.0018. Developer plan free (100 requests a day, development only); Business $449 a month for 250,000 requests, then $0.0018 each.
- **Rate:** 100 a day. Developer plan; Business includes 250,000 requests a month, Advanced 2,000,000.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set NEWSAPI_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

## AI providers

### openai

**OpenAI** (`ai`): OpenAI's models: responses, chat, embeddings, audio, images.

- **Settings:** `OPENAI_API_KEY`
- **What the key is:** A secret key from the API keys page; the Gateway puts it on every call as a bearer token.
- **Where the key comes from:** https://platform.openai.com/api-keys
- **API reference:** https://platform.openai.com/docs/api-reference
- **How it is sent:** `Authorization: Bearer <OPENAI_API_KEY>`, to `api.openai.com` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/openai/…` with `createGatewayFetch()`: POST to `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations`, and more only where both `AI_PROXY_EXTRA_ROUTES` and the app's `ai.routes` allow it; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/v1/chat/completions` with the operator's chat model (`ai model`), seeded with `gpt-6-luna`, when the app names no model and `/v1/embeddings` with the embeddings model, seeded with `text-embedding-3-small`; through AI Gateway as `openai` once it is on
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, live
- **Set it:** `pnpm everyapp secret set OPENAI_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [openai.md](openai.md)

### openrouter

**OpenRouter** (`ai`): One key for many models, through OpenAI's API shape.

- **Settings:** `OPENROUTER_API_KEY`
- **What the key is:** An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.
- **Where the key comes from:** https://openrouter.ai/settings/keys
- **API reference:** https://openrouter.ai/docs
- **How it is sent:** `Authorization: Bearer <OPENROUTER_API_KEY>`, to `openrouter.ai` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/openrouter/…` with `createGatewayFetch()`: POST to `/api/v1/chat/completions`, `/api/v1/completions`, `/api/v1/responses`, `/api/v1/embeddings`; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/api/v1/chat/completions` with the operator's chat model (`ai model`), seeded with `anthropic/claude-haiku-5.5`, when the app names no model and `/api/v1/embeddings` with the embeddings model, seeded with `openai/text-embedding-3-small`; through AI Gateway as `openrouter` once it is on
- **Smoke request:** none recorded
- **Cost:** per token. The answer's usage.cost is the call's price in USD, per model. The Gateway reads each answer's `usage.cost` field (US dollars) into the usage counters.
- **Rate:** not recorded
- **Verified:** 2026-10-25, live
- **Set it:** `pnpm everyapp secret set OPENROUTER_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [openrouter.md](openrouter.md)

### workers-ai

**Workers AI** (`ai`): Cloudflare's models, in the Gateway's own account.

- **Settings:** `WORKERS_AI_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`)
- **What the key is:** A Cloudflare API token with Workers AI Read (the Workers AI page's prefilled token); the account is the Gateway's own.
- **Where the key comes from:** https://dash.cloudflare.com/profile/api-tokens
- **API reference:** https://developers.cloudflare.com/workers-ai/
- **How it is sent:** `Authorization: Bearer <WORKERS_AI_API_TOKEN>`, to `api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/workers-ai/…` with `createGatewayFetch()`: POST to `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses`; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/v1/chat/completions` with the operator's chat model (`ai model`), seeded with `@cf/meta/llama-4-scout-17b-16e-instruct`, when the app names no model and `/v1/embeddings` with the embeddings model, seeded with `@cf/baai/bge-m3`; through AI Gateway as `workers-ai` once it is on
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, live
- **Set it:** `pnpm everyapp secret set WORKERS_AI_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [workers-ai.md](workers-ai.md)

### ai-gateway

**Cloudflare AI Gateway** (`ai`): Cloudflare's proxy in front of the other AI providers: logs, caching, rate limits and spend, with each provider's own key.

- **Settings:** `AI_GATEWAY_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`), `AI_GATEWAY_ID`
- **What the key is:** The gateway's id from the AI Gateway page (everyapp ai gateway on makes one named everyapp); AI_GATEWAY_API_KEY only for an authenticated gateway, sent as cf-aig-authorization. AI_GATEWAY_ID: The AI Gateway's id (its name in the dashboard), in the Gateway's own Cloudflare account. AI_GATEWAY_API_KEY: An AI Gateway token with Run permission, only when the gateway is authenticated; leave unset for an open gateway.
- **Where the key comes from:** https://dash.cloudflare.com/?to=/:account/ai/ai-gateway
- **API reference:** https://developers.cloudflare.com/ai-gateway/
- **How it is sent:** `cf-aig-authorization: Bearer <AI_GATEWAY_API_KEY>`, to `gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_ID}` only, over https
- **What apps may do:** nothing by id. With `AI_GATEWAY_ID` set (`pnpm everyapp ai gateway on`), every call to an AI provider that has an AI Gateway slug goes through `gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_ID}/<slug>/…` with the provider's own key still on it; a provider without a slug goes direct
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set AI_GATEWAY_API_KEY AI_GATEWAY_ID`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [ai-gateway.md](ai-gateway.md)

### anthropic

**Anthropic** (`ai`): Claude models through the Messages API.

- **Settings:** `ANTHROPIC_API_KEY`
- **What the key is:** An API key from the Claude Console's API keys page; the Gateway sends it as a bearer token. Apps send the anthropic-version header themselves. A key scoped to one workspace; the Gateway strips any anthropic-workspace-id header an app sends, so the key alone decides the workspace.
- **Where the key comes from:** https://platform.claude.com/settings/keys
- **API reference:** https://platform.claude.com/docs/en/api/overview
- **How it is sent:** `Authorization: Bearer <ANTHROPIC_API_KEY>`, to `api.anthropic.com` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/anthropic/…` with `createGatewayFetch()`: POST to `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/v1/chat/completions` with the operator's chat model (`ai model`), seeded with `claude-haiku-5-5`, when the app names no model; through AI Gateway as `anthropic` once it is on
- **Smoke request:** `GET https://api.anthropic.com/v1/models`, expecting 200; free. Send an anthropic-version header, as every call does.
- **Cost:** not recorded
- **Rate:** Requests and tokens per minute by usage tier, on the Console's Rate limits page; token counting is free, with its own per-minute limit.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set ANTHROPIC_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### gemini

**Google Gemini** (`ai`): Google's Gemini models through their OpenAI-compatible endpoint: chat, embeddings, images.

- **Settings:** `GEMINI_API_KEY`
- **What the key is:** An API key from Google AI Studio; the Gateway sends it as a bearer token. Apps call Gemini's OpenAI-shaped paths under /v1beta/openai. A Google AI Studio key restricted to the Gemini API only.
- **Where the key comes from:** https://aistudio.google.com/apikey
- **API reference:** https://ai.google.dev/gemini-api/docs/openai
- **How it is sent:** `Authorization: Bearer <GEMINI_API_KEY>`, to `generativelanguage.googleapis.com` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/gemini/…` with `createGatewayFetch()`: POST to `/v1beta/openai/chat/completions`, `/v1beta/openai/embeddings`, `/v1beta/openai/images/generations`; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/v1beta/openai/chat/completions` with the operator's chat model (`ai model`), seeded with `gemini-3.1-flash-lite`, when the app names no model and `/v1beta/openai/embeddings` with the embeddings model, seeded with `gemini-embedding-001`
- **Smoke request:** `GET https://generativelanguage.googleapis.com/v1beta/openai/models`, expecting 200; free
- **Cost:** not recorded
- **Rate:** Per project, not per key: requests and tokens per minute and requests per day, by tier (Free, then Tiers 1 to 3).
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set GEMINI_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### mistral

**Mistral AI** (`ai`): Mistral's models: chat, code completion, embeddings, moderation, OCR, speech.

- **Settings:** `MISTRAL_API_KEY`
- **What the key is:** An API key from API Keys in the Mistral Studio console; the Gateway sends it as a bearer token. Free mode needs no card; usage and rate limits apply. A key from API Keys in the Studio console, with an expiry date.
- **Where the key comes from:** https://console.mistral.ai
- **API reference:** https://docs.mistral.ai/api/
- **How it is sent:** `Authorization: Bearer <MISTRAL_API_KEY>`, to `api.mistral.ai` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/mistral/…` with `createGatewayFetch()`: POST to `/v1/chat/completions`, `/v1/fim/completions`, `/v1/embeddings`, `/v1/moderations`, `/v1/chat/moderations`, `/v1/classifications`, `/v1/chat/classifications`, `/v1/ocr`, `/v1/audio/transcriptions`, `/v1/audio/speech`; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/v1/chat/completions` with the operator's chat model (`ai model`), seeded with `mistral-small-latest`, when the app names no model and `/v1/embeddings` with the embeddings model, seeded with `mistral-embed`; through AI Gateway as `mistral` once it is on
- **Smoke request:** `GET https://api.mistral.ai/v1/models`, expecting 200; free
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set MISTRAL_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### groq

**Groq** (`ai`): Open models on Groq through OpenAI's API shape: chat, responses, transcription, speech.

- **Settings:** `GROQ_API_KEY`
- **What the key is:** An API key from the Groq console; the Gateway sends it as a bearer token. Apps call the OpenAI-shaped paths under /openai/v1. A key from the API Keys page of the Groq console.
- **Where the key comes from:** https://console.groq.com/keys
- **API reference:** https://console.groq.com/docs/api-reference
- **How it is sent:** `Authorization: Bearer <GROQ_API_KEY>`, to `api.groq.com` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/groq/…` with `createGatewayFetch()`: POST to `/openai/v1/chat/completions`, `/openai/v1/responses`, `/openai/v1/audio/transcriptions`, `/openai/v1/audio/translations`, `/openai/v1/audio/speech`; as the Gateway's default (`ai: { chat: true }`, `/api/ai/default/v1/chat/completions`) it serves `/openai/v1/chat/completions` with the operator's chat model (`ai model`), seeded with `openai/gpt-oss-20b`, when the app names no model; through AI Gateway as `groq` once it is on
- **Smoke request:** `GET https://api.groq.com/openai/v1/models`, expecting 200; free
- **Cost:** not recorded
- **Rate:** Requests and tokens per minute and per day, per model and plan, for the whole organization; the console Limits page shows them.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set GROQ_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

### cohere

**Cohere** (`ai`): Cohere's models: chat, embeddings, reranking, classification, transcription, document parsing.

- **Settings:** `COHERE_API_KEY`
- **What the key is:** An API key from the Cohere dashboard; the Gateway sends it as a bearer token. Trial keys are free and limited; production keys are paid. A production key; a trial key is limited to 1,000 calls a month.
- **Where the key comes from:** https://dashboard.cohere.com/api-keys
- **API reference:** https://docs.cohere.com/reference/about
- **How it is sent:** `Authorization: Bearer <COHERE_API_KEY>`, to `api.cohere.com` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/cohere/…` with `createGatewayFetch()`: POST to `/v2/chat`, `/v2/embed`, `/v2/rerank`, `/v1/classify`, `/v2/audio/transcriptions`, `/v2/parse`, `/v1/tokenize`, `/v1/detokenize`
- **Smoke request:** `GET https://api.cohere.com/v1/models`, expecting 200; free
- **Cost:** not recorded
- **Rate:** Production: 500 calls a minute for Command A chat and most endpoints, rerank 1,000. Trial: 20 chat calls a minute, 1,000 calls a month.
- **Verified:** 2026-10-25, docs
- **Set it:** `pnpm everyapp secret set COHERE_API_KEY`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** none beyond this section

## OAuth clients

### linkedin

**LinkedIn** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
- **Where the client comes from:** https://www.linkedin.com/developers/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/linkedin`, `https://<app>.<APP_BASE_DOMAIN>/integrations/social/linkedin-page`
- **How it is sent:** POST `www.linkedin.com/oauth/v2/accessToken` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### facebook

**Facebook** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`
- **Where the client comes from:** https://developers.facebook.com/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/facebook`, `https://<app>.<APP_BASE_DOMAIN>/integrations/social/instagram`
- **How it is sent:** GET/POST `graph.facebook.com/v<version>/oauth/access_token` (the client in the query)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set FACEBOOK_APP_ID FACEBOOK_APP_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### instagram

**Instagram** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`
- **Where the client comes from:** https://developers.facebook.com/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/instagram-standalone`
- **How it is sent:** POST `api.instagram.com/oauth/access_token` (the client in the form body); GET `graph.instagram.com/access_token` (the client in the query)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### threads

**Threads** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `THREADS_APP_ID`, `THREADS_APP_SECRET`
- **Where the client comes from:** https://developers.facebook.com/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/threads`
- **How it is sent:** GET/POST `graph.threads.net/oauth/access_token` (the client in the query); GET `graph.threads.net/access_token` (the client in the query)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set THREADS_APP_ID THREADS_APP_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### youtube

**YouTube** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`
- **Where the client comes from:** https://console.cloud.google.com/apis/credentials
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/youtube`, `https://<app>.<APP_BASE_DOMAIN>/integrations/social/gmb`
- **How it is sent:** POST `oauth2.googleapis.com/token` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET`
- **Guide:** [google.md](google.md)

### tiktok

**TikTok** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET`
- **Where the client comes from:** https://developers.tiktok.com/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/tiktok`
- **How it is sent:** POST `open.tiktokapis.com/v2/oauth/token/` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set TIKTOK_CLIENT_ID TIKTOK_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### tiktok-business

**TikTok Business** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `TIKTOK_BUSINESS_CLIENT_ID`, `TIKTOK_BUSINESS_CLIENT_SECRET`
- **Where the client comes from:** https://business-api.tiktok.com/portal/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/tiktok-business/`
- **How it is sent:** POST `business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/` (the client in the JSON body); POST `business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/` (the client in the JSON body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set TIKTOK_BUSINESS_CLIENT_ID TIKTOK_BUSINESS_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### reddit

**Reddit** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
- **Where the client comes from:** https://www.reddit.com/prefs/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/reddit`
- **How it is sent:** POST `www.reddit.com/api/v1/access_token` (the client in the Basic header)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### pinterest

**Pinterest** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`
- **Where the client comes from:** https://developers.pinterest.com/apps/
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/pinterest`
- **How it is sent:** POST `api.pinterest.com/v5/oauth/token` (the client in the Basic header)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set PINTEREST_CLIENT_ID PINTEREST_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### discord

**Discord** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- **Where the client comes from:** https://discord.com/developers/applications
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/discord`
- **How it is sent:** POST `discord.com/api/oauth2/token` (the client in the Basic header)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### slack

**Slack** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
- **Where the client comes from:** https://api.slack.com/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/slack`, `https://<app>.<APP_BASE_DOMAIN>/integrations/slack/callback`
- **How it is sent:** POST `slack.com/api/oauth.v2.access` (the client in the form body)
- **Scope sets an app lists:** `channels.read`, `users.read`, `users.email`, `messages.write`, `channels.join`, `channels.manage`, `files.write`, `user-channels.manage`
- **Set it:** `pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET`
- **Guide:** [slack.md](slack.md)

### mastodon

**Mastodon** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET`, `MASTODON_URL`
- **Where the client comes from:** `<MASTODON_URL>/settings/applications`
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/mastodon`
- **How it is sent:** POST `<MASTODON_URL>/oauth/token` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set MASTODON_CLIENT_ID MASTODON_CLIENT_SECRET MASTODON_URL`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### kick

**Kick** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`
- **Where the client comes from:** https://kick.com/settings/developer
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/kick`
- **How it is sent:** POST `id.kick.com/oauth/token` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set KICK_CLIENT_ID KICK_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### twitch

**Twitch** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
- **Where the client comes from:** https://dev.twitch.tv/console/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/twitch`
- **How it is sent:** POST `id.twitch.tv/oauth2/token` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### tumblr

**Tumblr** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `TUMBLR_CLIENT_ID`, `TUMBLR_CLIENT_SECRET`
- **Where the client comes from:** https://www.tumblr.com/oauth/apps
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/tumblr`
- **How it is sent:** POST `api.tumblr.com/v2/oauth2/token` (the client in the form body)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set TUMBLR_CLIENT_ID TUMBLR_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### dribbble

**Dribbble** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `DRIBBBLE_CLIENT_ID`, `DRIBBBLE_CLIENT_SECRET`
- **Where the client comes from:** https://dribbble.com/account/applications
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/social/dribbble`
- **How it is sent:** POST `dribbble.com/oauth/token` (the client in the query)
- **Scope sets an app lists:** none: the whole client is the grant
- **Set it:** `pnpm everyapp secret set DRIBBBLE_CLIENT_ID DRIBBBLE_CLIENT_SECRET`
- **Guide:** none beyond this section; the scopes to allow are in https://everyapp.com/docs/agent/repo/capabilities#oauth-clients

### google-workspace

**Google (Gmail, Calendar, Search Console and Analytics)** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`
- **Where the client comes from:** https://console.cloud.google.com/apis/credentials
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/google/callback`
- **How it is sent:** POST `oauth2.googleapis.com/token` (the client in the form body)
- **Scope sets an app lists:** `identity`, `gmail.read`, `calendar.read`, `search-console.read`, `analytics.read`
- **Set it:** `pnpm everyapp secret set GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET`
- **Guide:** [google.md](google.md)

### microsoft-365

**Microsoft 365 (Outlook mail and calendar)** (`oauth_client`): the Gateway holds the client and completes the token endpoints only; the app builds the authorize URL from the public client id and keeps people's tokens.

- **Settings:** `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET`
- **Where the client comes from:** https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
- **Redirect URIs to register:** `https://<app>.<APP_BASE_DOMAIN>/integrations/microsoft/callback`
- **How it is sent:** POST `login.microsoftonline.com/common/oauth2/v2.0/token` (the client in the form body)
- **Scope sets an app lists:** `identity`, `mail.read`, `calendar.read`
- **Set it:** `pnpm everyapp secret set MICROSOFT_365_CLIENT_ID MICROSOFT_365_CLIENT_SECRET`
- **Guide:** [microsoft-365.md](microsoft-365.md)
