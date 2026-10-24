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

AI providers stay separate: `providers: ["openai", "openrouter", "workers-ai"]`
and the `/api/ai/<provider>` proxy, with their model and route allowlists.

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

## The three kinds

One registry (`packages/sdk/src/internal/capabilities.ts`) defines every
capability; its `mode` is the kind. All three take the same manifest entry,
`capabilities: { <id>: { access, scopes, why, docs, optional, anyOf } }`
(`access`, `scopes` for a client with scope sets ([OAuth clients](#oauth-clients)),
and the need fields of [docs/manifest-settings.md](manifest-settings.md)),
travel the app's private binding to the gateway under
`/api/integrations/<id>/...`, and answer `GET /api/integrations/<id>`
(`integrationStatus`) without calling out.

| Kind           | Capabilities                                          | What the gateway does                                                             | The app calls                                                                            | Access  | Status adds                     |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------- | ------------------------------- |
| `api_key`      | `dataforseo`, `context`                               | puts its key on calls to the provider's own hosts, with the methods it reads with | `integrationFetch({ env, provider, for })` on the provider's real URLs                   | `read`  |                                 |
| `oauth_client` | 16 social networks, Google and Microsoft mail and calendar ([OAuth clients](#oauth-clients))  | completes the network's token endpoints only, putting its client on the request   | `integrationFetch` on the token endpoint; the authorize URL from the status's `clientId` | `write` | `clientId` (Mastodon: `origin`) |
| `service`      | `email` ([Gateway services](#gateway-services-email)) | does the work itself: sends the mail from its sender, within its budgets          | `sendEmail({ env, for, message })`, which posts to `/api/integrations/email/send`        | `write` | `sender`, `senders`, `provider` |
| `service`      | `members` ([Gateway services](#gateway-services-members)) | does the work itself: reads its own directory of who can open the app          | `listMembers({ env, for })`, which gets `/api/integrations/members/list`        | `read` |  |

Every status answers `{ capability, requested, configured, ready }`;
`configured` is false for an app that doesn't list the capability, so no app
learns what the operator holds. The AI providers are not a kind yet: an app
lists them in `providers` (and limits them with `ai.models`) and calls
`/api/ai/<provider>/...` with `createGatewayFetch()`.

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
| `openrouter`                | AI provider         | `OPENROUTER_API_KEY`                                                                                                       | `OPENROUTER_API_KEY`                                                                                           | OpenSEO; agentic-inbox with `AI_PROVIDER=openrouter` |
| `workers-ai`                | AI provider         | `WORKERS_AI_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID` (which `everyapp setup` sets)                                         | `WORKERS_AI_API_TOKEN` (the Workers AI page's prefilled token: Workers AI Read; a token made by hand needs Workers AI Read and Edit) | agentic-inbox with `AI_PROVIDER=workers-ai`          |
| the AI proxy's extra routes | AI provider setting | `AI_PROXY_EXTRA_ROUTES` (optional; OpenAI only, e.g. `/v1/files`)                                                          | `AI_PROXY_EXTRA_ROUTES`                                                                                        |                                                      |
| `dataforseo`                | `api_key`           | `DATAFORSEO_API_KEY` (`login:password`, or its base64)                                                                     | `DATAFORSEO_API_KEY`                                                                                           | OpenSEO                                              |
| `context`                   | `api_key`           | `CONTEXT_API_KEY`                                                                                                          | `CONTEXT_API_KEY`                                                                                              | OpenSEO                                              |
| `email`                     | `service`           | `EMAIL_FROM` with a display name, from `EMAIL_FROM_NAME` or `EMAIL_FROM="Name <address>"`, and one provider: Cloudflare Email Sending (the `EMAIL` binding; outside Workers `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) or Resend (`RESEND_API_KEY`); `EMAIL_PROVIDER` picks one when both are set | `EMAIL_FROM EMAIL_FROM_NAME` (or `EMAIL_FROM` alone as `Name <address>`; and `RESEND_API_KEY`, `EMAIL_PROVIDER`), after setting up the sending domain ([runbook](runbooks/email-sending-setup.md)); an app's own senders with `everyapp email set --sender` | agentic-inbox, OpenAnalytics, and the gateway's own mail |
| `members`                   | `service`           | none: the gateway reads its own directory                                                                                   | nothing to set                                                                                                 | OpenAnalytics (whom reports go to)                   |
| 16 social networks          | `oauth_client`      | `<NETWORK>_CLIENT_ID`, `<NETWORK>_CLIENT_SECRET` (Meta's networks: `_APP_ID`, `_APP_SECRET`); Mastodon also `MASTODON_URL` | one line per network, generated [below](#oauth-clients)                                                        | OpenCRM (`slack`); the other 15 were added for Postiz's port |
| `google-workspace`, `microsoft-365` | `oauth_client` | `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`; `MICROSOFT_365_CLIENT_ID`, `MICROSOFT_365_CLIENT_SECRET` | generated [below](#oauth-clients) | OpenCRM (mail and calendar capture); OpenSEO (Search Console and Analytics) |

X is not in the table: OAuth 1.0a signs every API call with the user's token
secret, which the gateway never holds, so an app keeps `X_API_KEY` and
`X_API_SECRET` as its own secrets (`pnpm everyapp secret set X_API_KEY
X_API_SECRET` in the app's directory, or anywhere with `--app <id>`, after
its first deploy).

### API-key providers

| Capability   | Gateway secret       | Hosts the key may reach                        | Access |
| ------------ | -------------------- | ---------------------------------------------- | ------ |
| `dataforseo` | `DATAFORSEO_API_KEY` | `api.dataforseo.com`, `sandbox.dataforseo.com` | `read` |
| `context`    | `CONTEXT_API_KEY`    | `api.context.dev`                              | `read` |

DataForSEO can also go to members' AI clients directly, with nothing
deployed: `pnpm everyapp provider on dataforseo` ([Provider apps](#provider-apps)).

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

`everyapp deploy` refuses a capability the gateway doesn't offer and an
access level it doesn't offer (`write`, for both providers today; `read`,
for email and the OAuth clients).

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
  for: request,
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
  call the app makes. Pass `for: request` and the gateway attributes the
  call to the request's user; for background work (crons, Workflows,
  queues) an organization's own app omits it (or passes
  `{ background: true }`) and the call is the app's. A shared app's Worker
  serves every organization, so its background work passes
  `for: { background: true, organizationId }`, sent as `x-everyapp-org`;
  the gateway accepts it for an active organization with a live member and
  attributes the call to that organization. A shared Worker's call that
  names neither throws `AttributionError`.
- In local dev (`everyapp dev`, no binding) the fetch calls the provider
  directly with the developer's own key from `.dev.vars`, under the same
  name as the gateway secret.

## What the gateway checks on an API-key call

`AppGateway` serves `/api/integrations/<capability>/<host>/<path>` over the
app's private binding (`apps/every-app-gateway/src/server/integration-proxy.ts`):

1. The caller is a registered, active app (the binding's props, as for AI).
2. Its registry row's manifest lists this capability; otherwise
   `capability_not_requested` (403).
3. The host is one of the provider's, over https, with no path that could
   leave it; otherwise `invalid_integration_route` (400).
4. The path isn't one that lists or describes the whole provider account
   (DataForSEO's `tasks_ready`, `tasks_fixed`, `id_list`, `errors`, `appendix/user_data`,
   `appendix/webhook_resend`): one key serves every app in every
   organization; otherwise `integration_path_not_allowed` (403).
5. The method is one the provider reads with; otherwise
   `integration_method_not_allowed` (405).
6. The gateway has a key; otherwise `integration_not_configured` (503), whose
   message names the secret and who sets it.

It then drops the app's `Authorization`, `x-api-key`, cookies and every
`x-everyapp-*` header, puts its own credential on the request, refuses to
follow redirects, and streams the body both ways. A provider it cannot reach
is `integration_upstream_failed` (502). Every call is logged
(`integration.proxy.call`) with the organization, app, path, status,
attribution, and DataForSEO's `cost` from the response. Refusals the gateway
makes, the AppGateway entrypoint's own included (`caller_not_registered`,
`invalid_gateway_route`, ...), carry their code in `x-everyapp-error` so an
app can tell them from the provider's own errors.

`GET /api/integrations/<capability>` answers
`{ capability, requested, configured, ready }` without calling the provider
(`integrationStatus`); `configured` is false for an app that doesn't list the
capability, so no app learns which keys the operator holds.

## OAuth clients

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
const linkedin = integrationFetch({ env, provider: "linkedin", for: request });
const tokens = await linkedin("https://www.linkedin.com/oauth/v2/accessToken", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
});
// A refresh from a cron or Workflow: for: { background: true, organizationId }.
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
| `email`    | `EMAIL_FROM` with a display name (`EMAIL_FROM_NAME`, or `EMAIL_FROM` as `Name <address>`); Cloudflare: the `EMAIL` binding, or `EMAIL_REST_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`; Resend: `RESEND_API_KEY`; `EMAIL_PROVIDER` (`cloudflare` or `resend`) when both are set | `POST /api/integrations/email/send` | `write` |

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
    env,
    for: request, // or { background: true, organizationId } from a cron or email()
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
is no per-organization mail budget (the monthly cap in Admin → Usage counts
provider calls, not mail). A message
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

const { members } = await listMembers({
  env,
  for: { background: true }, // or the request; a shared app names organizationId
});
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

## Provider apps

A provider app offers an `api_key` provider's data to members' AI clients
directly, as an app of the gateway's own with nothing to deploy: the
operator turns it on (`pnpm everyapp provider on dataforseo`) and sets the
key as for any capability; the gateway serves a curated set of the
provider's tools on its `/mcp` under `<id>_<tool>` names. The registry is
`PROVIDER_APPS` in `packages/sdk/src/internal/providerApps.ts`; the row is
an `apps` row on tier `provider` with no hostname or Worker, whose generated
manifest lists the capability with `access: "read"`, so the key's need shows
wherever an app's settings do. Each tool call goes through the same checks
as an app's capability call (the provider's hosts, the account-wide paths,
the key, the cost tap) and is counted and audited against the provider row.
The agent docs page is
[/docs/agent/mcp](https://everyapp.com/docs/agent/mcp) ("Provider apps").

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
  provider's reported cost (Admin → Usage; `usage_daily`, `usage_monthly`),
  and an owner or admin can cap an app's provider calls per month there
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
