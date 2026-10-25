<!-- generated: pnpm -C packages/cli docs:update writes this file from the built-in catalog (packages/sdk/src/internal/capabilities.ts, through packages/cli/src/docs/providersCatalog.ts). Edit the catalog, never this file: a test fails CI when it is stale. -->

# Every catalog provider: its settings, its key and one check

For a coding agent setting up a provider the Gateway's built-in catalog has. Each provider is a section under its id, so `setup/providers.md#<id>` points at it. Where the provider has a file of its own in this folder (its **Guide**), follow that file and read this section as its summary. Read [README.md](README.md) first: its rules hold here too, above all that a key never goes through the chat.

A provider registered on one Gateway (`pnpm everyapp provider add`) is not in this file: `pnpm everyapp provider show <id>` prints its whole spec (its hint, settings, hosts, where the key comes from and its smoke request). The catalog has 23 providers: 2 API-key, 3 AI, 18 OAuth clients.

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
| [`openai`](#openai) | OpenAI | AI | `OPENAI_API_KEY` | [openai.md](openai.md) |
| [`openrouter`](#openrouter) | OpenRouter | AI | `OPENROUTER_API_KEY` | [openrouter.md](openrouter.md) |
| [`workers-ai`](#workers-ai) | Workers AI | AI | `WORKERS_AI_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (set by `everyapp setup`) | [workers-ai.md](workers-ai.md) |
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

## AI providers

### openai

**OpenAI** (`ai`): OpenAI's models: responses, chat, embeddings, audio, images.

- **Settings:** `OPENAI_API_KEY`
- **What the key is:** A secret key from the API keys page; the Gateway puts it on every call as a bearer token.
- **Where the key comes from:** https://platform.openai.com/api-keys
- **API reference:** https://platform.openai.com/docs/api-reference
- **How it is sent:** `Authorization: Bearer <OPENAI_API_KEY>`, to `api.openai.com` only, over https
- **What apps may do:** list it under `providers` and call `/api/ai/openai/…` with `createGatewayFetch()`: POST to `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations`, and more only where both `AI_PROXY_EXTRA_ROUTES` and the app's `ai.routes` allow it
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
- **What apps may do:** list it under `providers` and call `/api/ai/openrouter/…` with `createGatewayFetch()`: POST to `/api/v1/chat/completions`, `/api/v1/completions`, `/api/v1/responses`, `/api/v1/embeddings`
- **Smoke request:** none recorded
- **Cost:** not recorded
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
- **What apps may do:** list it under `providers` and call `/api/ai/workers-ai/…` with `createGatewayFetch()`: POST to `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses`
- **Smoke request:** none recorded
- **Cost:** not recorded
- **Rate:** not recorded
- **Verified:** 2026-10-25, live
- **Set it:** `pnpm everyapp secret set WORKERS_AI_API_TOKEN`, or `pnpm everyapp configure <app id>` for everything an app needs
- **Guide:** [workers-ai.md](workers-ai.md)

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
