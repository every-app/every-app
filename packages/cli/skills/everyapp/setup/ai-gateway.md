# Cloudflare AI Gateway in front of the model providers

Cloudflare AI Gateway is a proxy for model calls in the Gateway's own
Cloudflare account: a log of every call, caching, rate limits, retries
and a spend view, at `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/…`.
It has no models of its own and never replaces a provider's key: with it
on, every call the Gateway makes to an AI provider that has an AI Gateway
slug (OpenRouter, OpenAI, Anthropic, Groq, Mistral, Workers AI) goes
through it with the provider's own key still on the call; Gemini and
Cohere go direct (Cloudflare documents no form for their OpenAI-shaped
paths). It changes no app and no manifest. At the end the person has an
AI Gateway named `everyapp` in their account, `AI_GATEWAY_ID` on the
Gateway, and every model call showing up in the AI Gateway dashboard.

## Settings

| NAME                 | Required or optional                               | What it holds                                                                                           |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AI_GATEWAY_ID`      | optional (set by `pnpm everyapp ai gateway on`)    | the AI Gateway's id, its name in the dashboard (`everyapp`); with `CLOUDFLARE_ACCOUNT_ID`, which `everyapp setup` set |
| `AI_GATEWAY_API_KEY` | optional, only for an authenticated gateway         | an AI Gateway token with Run permission, sent as `cf-aig-authorization: Bearer <token>`                  |

The Gateway sends the gateway token only to `gateway.ai.cloudflare.com`
and, for Workers AI, `api.cloudflare.com` with `cf-aig-gateway-id`. Apps
can't set `cf-aig-*` headers: the proxy strips them.

## Costs and plans

As of October 2026: AI Gateway is included with a Cloudflare account on
every plan, with logs kept per plan (Workers Free: 100,000 logs per
gateway; Paid: 10 million) and no per-request charge of its own; the
provider's prices are unchanged (BYOK: the provider's key is the
provider's bill). Unified Billing (paying providers through Cloudflare
credits) is not used: the Gateway always sends the provider's key, and
`cf-aig-no-wholesale` is not needed because a key on the request wins.

## Only a person can

- Decide to turn it on (it adds a hop and a log of every prompt's
  metadata, never the prompt itself unless logging of payloads is turned
  on in the dashboard).
- Create a gateway token in the dashboard when they want an
  authenticated gateway, and paste it into the terminal.
- Turn on caching, rate limits or payload logging in the AI Gateway
  dashboard: the Gateway sends no `cf-aig-*` options; the gateway's own
  settings apply to every call.

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed`
   true; otherwise [gateway.md](gateway.md) first.
2. `pnpm everyapp ai show --json`: `done.data.aiGateway.on` false means
   it isn't on; `done.data.via` says `direct`. At least one model
   provider configured ([ai.md](ai.md)) so there is something to front.
3. The Cloudflare login the CLI uses can create AI Gateways in the
   account (the account owner's login, or a token with AI Gateway Write).

## Steps

1. **Turn it on**: `pnpm everyapp ai gateway on --json`. The CLI finds or
   creates an AI Gateway named `everyapp` in the Gateway's account
   (`--id <name>` for another name, or one the person made already) and
   sets `AI_GATEWAY_ID` on the Gateway. `done.data` is `{ id, url,
   created }`. From the Gateway's next request every slugged provider
   call goes through it.
2. **Authenticated gateway (optional).** In the dashboard, AI → AI
   Gateway → the gateway → Settings → Authenticated Gateway: on; create
   an AI Gateway token (Run permission). Then from the person's
   terminal: `pnpm everyapp secret set AI_GATEWAY_API_KEY` (the value by
   pipe or prompt, never on the command line). Without the token on an
   authenticated gateway every model call answers 401 from AI Gateway.
3. Nothing else: no app changes, no key moves.

## Verify

1. `pnpm everyapp ai show --json`: `done.data.aiGateway` is `{ on: true,
   id: "everyapp" }` and `done.data.via` is `ai-gateway`.
2. Make one model call in an app (ask Agentic Inbox's agent something),
   then open the dashboard: AI → AI Gateway → `everyapp` → Logs shows
   the request with the provider's name.
3. Manage workspace → Usage still counts the call under its provider:
   AI Gateway adds a hop, not a provider.

## If it fails

- `ai gateway on` fails with a Cloudflare error: the login can't create
  AI Gateways (a scoped token without AI Gateway Write); use the
  account owner's login, or make the gateway in the dashboard and run
  `ai gateway on --id <its name>`.
- A model call answers 401 after turning it on: the gateway is
  authenticated and `AI_GATEWAY_API_KEY` isn't set (step 2) or is wrong
  (rotate it).
- A model call answers 404 or 400 from `gateway.ai.cloudflare.com`: a
  provider path AI Gateway doesn't serve the way the catalog recorded
  it (the entry's `aig` block; `landing-page/content/agent/ai.md` lists
  each). `pnpm everyapp ai gateway off` sends everything direct again
  while it is looked at.
- Calls work but don't appear in the dashboard: the provider has no
  slug (Gemini, Cohere) and went direct.

## Rerun, rotate, remove

- `ai gateway on` again is safe: it finds the existing gateway and
  rewrites the same id.
- Rotate the gateway token in the dashboard, then `pnpm everyapp secret
  set AI_GATEWAY_API_KEY` again.
- `pnpm everyapp ai gateway off` unsets `AI_GATEWAY_ID`: every call goes
  direct from the next request; the AI Gateway resource and its logs
  stay in the account (delete it in the dashboard). `pnpm everyapp secret
  unset AI_GATEWAY_API_KEY` removes the token.

## Sources

- https://developers.cloudflare.com/ai-gateway/ (overview; provider
  pages under usage/providers/; authentication under
  configuration/authentication/; the header glossary), read 2026-10-25.
- https://everyapp.com/docs/agent/ai (in the checkout
  `landing-page/content/agent/ai.md`): how each provider is fronted.
