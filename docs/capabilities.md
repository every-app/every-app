# Capabilities the gateway holds

An app often needs a third-party API that isn't AI: DataForSEO for SEO data,
Context.dev for rendering pages, later GitHub, Google or Slack. The gateway
holds the credential once, an app lists the capability in its manifest, and
the app calls through the gateway. No app holds the key, and a deploy needs
no per-app settings.

This is phase 0 of the integrations design (branch
`research/app-integrations`, `docs/research/2026-10-integrations-hub/app-integrations.md`):
**API-key providers whose key the gateway holds**, plus **gateway services**,
things the gateway does itself for apps (sending email, [below](#gateway-services-email)).
OAuth providers, per-organization accounts and admin approval come in later
phases and keep the same manifest entry, binding route and SDK call.

AI providers stay separate: `providers: ["openai", "openrouter"]` and the
`/api/ai/<provider>` proxy, with their model and route allowlists.

What comes next is designed, not built: the October 2026 redesign review
([docs/design/2026-10-redesign-review.md](design/2026-10-redesign-review.md))
folds AI providers into this model behind one route and one SDK fetch, and the
Google design ([docs/design/2026-10-google-integration.md](design/2026-10-google-integration.md))
adds organization-held OAuth accounts under an operator-held client. Both were
re-aligned on 2026-10-16 with the hosted-platform research
(`docs/research/2026-10-hosted-platform/` on `research/hosted-platform`, PR
#299): in hosted, first-party apps share one Worker per app and third-party
apps get one Worker per organization on Workers for Platforms, and the gateway
learns the organization per call. Both documents were written when the
manifest key was `integrations` with `as` and `background` on each entry; read
them with this document's `capabilities` and `{ access, why }`.

## For an operator

Set the key once on the gateway:

```bash
pnpm everyapp secret set DATAFORSEO_API_KEY --for gateway
```

DataForSEO takes the API login and password, as `login:password` or the
base64 of it. The command redeploys the live gateway release with the key;
every app that lists DataForSEO can use it from then on.

| Capability   | Gateway secret       | Hosts the key may reach                        | Access |
| ------------ | -------------------- | ---------------------------------------------- | ------ |
| `dataforseo` | `DATAFORSEO_API_KEY` | `api.dataforseo.com`, `sandbox.dataforseo.com` | `read` |
| `context`    | `CONTEXT_API_KEY`    | `api.context.dev`                              | `read` |

The AI proxy's keys are set the same way. An app lists the provider in its
manifest's `providers` and calls `/api/ai/<provider>/...` with
`createGatewayFetch()`; `ai.models` limits the models it may ask for.

| AI provider  | Gateway setting                                  | Upstream                                             | Routes apps may call                                      |
| ------------ | ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| `openai`     | `OPENAI_API_KEY`                                 | `api.openai.com`                                     | inference, plus what `AI_PROXY_EXTRA_ROUTES` allows       |
| `openrouter` | `OPENROUTER_API_KEY`                             | `openrouter.ai`                                      | inference                                                 |
| `workers-ai` | `WORKERS_AI_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `api.cloudflare.com/client/v4/accounts/<account>/ai` | `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses` |

Workers AI runs in the gateway's own account (`CLOUDFLARE_ACCOUNT_ID`, which
`everyapp setup` sets) with an API token made from the "Workers AI"
template (Workers AI Read and Edit):

```bash
pnpm everyapp secret set WORKERS_AI_API_TOKEN --for gateway
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
for email).

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

## What the gateway checks

`AppGateway` serves `/api/integrations/<capability>/<host>/<path>` over the
app's private binding (`apps/every-app-gateway/src/server/integration-proxy.ts`):

1. The caller is a registered, active app (the binding's props, as for AI).
2. Its registry row's manifest lists this capability; otherwise
   `capability_not_requested` (403).
3. The host is one of the provider's, over https, with no path that could
   leave it; otherwise `invalid_integration_route` (400).
4. The path isn't one that lists or describes the whole provider account
   (DataForSEO's `tasks_ready`, `id_list`, `errors`, `appendix/user_data`,
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

## Gateway services: email

`email` is a capability the gateway performs itself: apps send mail through
the gateway's own sender and transport (its `EMAIL` binding, or Email
Sending's REST API on a gateway outside Workers), within its daily budgets.
One sending domain onboarded per gateway serves every app, and every message
is attributed and logged. Apps get no `send-email` binding (the deploy
refuses one); they call `sendEmail()`.

| Capability | Gateway settings                                                                   | Route                               | Access  |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------- | ------- |
| `email`    | `EMAIL_FROM`, `EMAIL_FROM_NAME` (REST: `EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) | `POST /api/integrations/email/send` | `write` |

The operator's side is the email runbook
([docs/runbooks/email-sending-setup.md](runbooks/email-sending-setup.md)):
onboard the gateway's sending domain, then set the sender. The gateway's own
invitation and password-reset mail uses the same setup.

An app lists it, with the addresses it may send as:

```ts
capabilities: {
  email: {
    access: "write",
    why: "Sends replies from the organization's mailboxes.",
    // Optional: without senders, mail goes out as the gateway's sender only.
    senders: ["*@mail.example.com", "billing@example.com"],
  },
},
```

and sends:

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
| `from`        | address or `{ address, name? }`                                                      | absent: the gateway's sender; present: must match a `senders` pattern |
| `replyTo`     | address or `{ address, name? }`                                                      | absent: replies go to the sender                                  |
| `headers`     | `{ name: value }`                                                                    | 20 at most, values one line of 2,048 bytes at most; `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Sender`, `Return-Path`, `Date`, MIME and DKIM headers are refused (the message's own fields set them) |
| `attachments` | `[{ filename, contentType, content (base64), disposition?: "attachment" \| "inline", contentId? }]` | 32 at most; an inline one needs a `contentId` (`cid:` in the HTML) |

Unknown fields are refused. The answer is `200 { messageId?, status }`:
`delivered` (Email Sending accepted it) or `queued` (the REST transport will
retry some recipients). In local dev the SDK answers `logged` (below).

**The sender rule.** Without `from`, the message goes out as `EMAIL_FROM`
(with `EMAIL_FROM_NAME`). With one, the address must match a pattern in the
deployed manifest's `capabilities.email.senders`: `*@<domain>` takes any
address on exactly that domain (not its subdomains), anything else that one
address; patterns are lowercase, unique, 20 at most, and `everyapp deploy`
checks them. Each domain an app sends from must also be onboarded to Email
Sending in the gateway's Cloudflare account (on Cloudflare DNS), or the
provider refuses it: `email_sender_not_verified`, whose message names the
onboarding command. A hosted gateway sends app mail from its own sender
only, for now: any `from` is refused.

**Budgets.** App mail (`app` kind) counts against daily budgets in
`rate_limit_counters`, once for each distinct recipient, before it is sent:
100 per recipient address and 5,000 for the whole gateway a day when
self-hosted, 20 and 5,000 when hosted, none when the mode is invalid. There
is no per-organization budget (usage limits are a later feature). A message
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
| `email_invalid_message`          | 400    | the message breaks a rule above, or Email Sending refuses it as malformed                    |
| `email_sender_not_allowed`       | 403    | `from` matches no `senders` pattern, or the gateway is hosted                                |
| `integration_not_configured`     | 503    | the gateway has no sender or transport; the message names `EMAIL_FROM`, `EMAIL_FROM_NAME` and the runbook |
| `email_budget_exhausted`         | 429    | a recipient or the gateway has had its day's app mail (`Retry-After`)                        |
| `email_budget_unavailable`       | 503    | the budget couldn't be read or written, so nothing was sent                                  |
| `email_sender_not_verified`      | 422    | Email Sending: the sender's domain isn't onboarded (`E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`) |
| `email_provider_limited`         | 429    | Email Sending: the account's rate or daily limit (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`) |
| `email_send_failed`              | 502    | anything else Email Sending answered                                                         |

Every send is logged as `email.app.send` with the organization, app,
Worker, number of recipients, an HMAC of the first recipient, whether the
sender was the gateway's or the app's, the status (or `refused` and the
reason) and the attribution; never the subject, the bodies, the
attachments or an address.

`GET /api/integrations/email` (`integrationStatus({ env, provider: "email" })`)
answers `{ capability, requested, configured, ready, sender, senders }`
without sending: `sender` is the From a message without `from` gets (null
unless configured), `senders` the patterns the gateway accepts from this
app (empty on a hosted gateway). An app shows "sending isn't set up" from
`ready`, and offers only addresses `senders` allows.

**Local dev.** With no gateway, `sendEmail()` checks the message and the
sender the same way (the manifest's `senders` reach the Worker in dev as
`EVERYAPP_EMAIL_SENDERS`), then prints
`[everyapp dev] email to <n> recipients subject "<subject>"` and answers
`{ status: "logged", messageId: "dev-<uuid>" }`. With
`EMAIL_REST_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `EMAIL_FROM` in
`.dev.vars` it really sends, through Email Sending's REST API from the
developer's own account.

**Inbound mail** is not a capability: the app exports an `email()` handler
beside `everyApp()`'s `fetch`, and an Email Routing rule sends the
domain's mail to the app's Worker. The deploy policy keeps refusing the
`email` trigger, so for now the rule is a manual step
([docs/runbooks/email-sending-setup.md](runbooks/email-sending-setup.md#inbound-mail-to-an-app)).
The handler runs with no identity: its gateway calls pass
`for: { background: true, organizationId }` and treat the message as
untrusted.

## Limits today

- One key per provider, shared by every app that lists it, with no spend
  caps. Whoever can deploy an app can list any capability, as for AI
  providers (deploying already takes credentials that can change the
  gateway).
- Calls are logged, not metered.
- The key lives in a gateway Worker secret, not encrypted in D1 with
  rotation in the UI, as the full design has it.
