# The default model provider

An app that says `ai: { chat: true }` in its manifest (OpenMail,
OpenCRM's research agent) takes whichever chat model the Gateway's
operator made the default, through `/api/ai/default/…`; it never names a
provider. One key, set once, makes every such app work. This file sets
that one key and, when the person wants a particular provider or model,
the choice. At the end the person has one model provider's key on the
Gateway, `pnpm everyapp ai show` saying what the default resolves to,
and every app that needs "a chat model" open.

## Settings

| NAME                                                     | Required or optional                         | What it holds                                                                                              |
| -------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| one provider's key (`OPENROUTER_API_KEY` first in the order) | required by every app whose manifest says `ai.chat` | the provider's key as its file says ([openrouter.md](openrouter.md), [workers-ai.md](workers-ai.md), [openai.md](openai.md), or [providers.md](providers.md) under `anthropic`, `groq`, `mistral`, `gemini`) |
| the choice (`pnpm everyapp ai default <provider>[/<model>]`) | optional                                     | which provider (and model) the default is; without it the order decides                                     |

The order the Gateway resolves the default in, the first whose settings
are set: `openrouter` (one key, many models, the price in every answer),
`workers-ai` (no provider account: the Gateway's own Cloudflare token;
weaker models), `openai`, `anthropic`, `groq`, `mistral`, `gemini`. The
operator's choice wins over the order. Cloudflare AI Gateway is never
the default: it fronts whichever provider resolves
([ai-gateway.md](ai-gateway.md)).

## Costs and plans

The provider's: OpenRouter is prepaid in USD at the providers' own
prices ([openrouter.md](openrouter.md)); Workers AI bills the Cloudflare
account per token ([workers-ai.md](workers-ai.md)); the others each have
a plan of their own, named in their section of
[providers.md](providers.md). The model the Gateway fills in when an app
names none is a cheap capable one per provider (OpenRouter
`anthropic/claude-haiku-5.5`, Workers AI
`@cf/meta/llama-4-scout-17b-16e-instruct`, OpenAI `gpt-6-luna`, Groq
`openai/gpt-oss-20b`, Mistral `mistral-small-latest`, Gemini
`gemini-3.1-flash-lite`); `pnpm everyapp ai default <provider>/<model>`
picks another. Usage by provider and model is on Manage workspace →
Usage and in `pnpm everyapp workspace usage --json` (`byModel`).

## Only a person can

- Open an account with the provider and buy credits or add a card.
- Create the key there and paste it into the terminal (the value never
  goes through the chat or the command line).
- Decide the provider and model when the shipped order isn't what they
  want (a model they trust, a region, a budget).

## Before you start

1. `pnpm everyapp status --json`: `data.installed` and `data.claimed`
   true; otherwise [gateway.md](gateway.md) first.
2. Whether this file applies: an app in `data.apps[]` whose `setup.unmet`
   has a setting with `kind: "ai-default"` (label "A chat model (…)"),
   or whose `setup.settings` lists one. Its `names` is the key the order
   asks for first and its `hint` names the alternatives. No such app:
   nothing to do here; an app that pins a provider is that provider's
   file.
3. `pnpm everyapp ai show --json`: `done.data.configured` false means no
   provider is set yet; `done.data.provider` and `done.data.settings`
   say which key the default would use; `done.data.candidates[]` lists
   every provider with `configured`.

## Steps

1. **Pick the provider with the person.** Default to OpenRouter unless
   they say otherwise: it is one key for every model and the only one
   whose spend the Gateway counts in dollars. Workers AI when they want
   no provider account at all. A single vendor when they already have a
   key there.
2. **Set that provider's key**, by its own file: [openrouter.md](openrouter.md)
   (`OPENROUTER_API_KEY`), [workers-ai.md](workers-ai.md)
   (`WORKERS_AI_API_TOKEN`), [openai.md](openai.md) (`OPENAI_API_KEY`),
   or the provider's section of [providers.md](providers.md)
   (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`,
   `GEMINI_API_KEY`). Each ends with `pnpm everyapp secret set <NAME>`,
   the value from the person's terminal, or `pnpm everyapp configure
   <app id>`, which asks for exactly the one key the app's `ai-default`
   setting names.
3. **Store the choice when it isn't the order's.** The first configured
   provider of the order is the default by itself; nothing to store when
   it is OpenRouter and the person is happy with its model. Otherwise:
   `pnpm everyapp ai default <provider>` (`groq`), or with a model,
   `pnpm everyapp ai default openrouter/anthropic/claude-sonnet-5.5`
   (the provider id up to the first slash, the model after it). `pnpm
   everyapp ai default off` clears it. Each change queues the
   `ai.default_changed` event.
4. **Optionally put AI Gateway in front**: [ai-gateway.md](ai-gateway.md)
   (`pnpm everyapp ai gateway on`), for logs, caching and limits on
   every model call; it changes no app and no key.

## Verify

1. `pnpm everyapp ai show --json`: `done.data.configured` true,
   `done.data.provider` the one the person picked (or the order's
   first), `done.data.model` the model that will be filled in,
   `done.data.via` `ai-gateway` once the gateway is on, else `direct`.
2. `pnpm everyapp status --json`: every app that said `ai.chat` has
   `setup.ready` true and no `ai-default` setting in `setup.unmet`.
3. In the app: a chat answer arrives (OpenMail: open a thread and
   ask the agent; OpenCRM: run research on a company). Manage workspace
   → Usage → By provider shows the provider and, under it, the model.

## If it fails

- `ai_default_not_configured` in an app's error (503): no provider's
  key is set, or the chosen one's isn't. The message names the key;
  step 2. `pnpm everyapp ai show` says the same with `configured: false`.
- `AI_DEFAULT_INVALID` from `ai default`: the id isn't a provider the
  Gateway knows, is an API provider (Stripe), has no OpenAI-shaped chat
  route (Cohere: an app pins it under `providers`), or is `ai-gateway`
  (turn it on with `ai gateway on` and pick a model provider). The
  message names the candidates.
- `ai_route_not_allowed` on the default route: the app called something
  other than chat completions or embeddings; it lists the provider under
  `providers` for that.
- `model_not_allowed` never comes from the default route; an app seeing
  it pinned a provider and limited `ai.models`.
- A provider's own error (401, 429, a model name it doesn't serve): the
  provider's file, "If it fails".

## Rerun, rotate, remove

- Rerunning any step is safe: `ai default` overwrites the choice, a key
  set again replaces the old one on the next request.
- Rotate a key as its provider's file says; the default resolves to the
  same provider.
- Remove the choice with `pnpm everyapp ai default off`; remove a key
  with `pnpm everyapp secret unset <NAME>`, after which the order moves
  to the next configured provider, or apps that need the default show
  "Needs setup" again.

## Sources

- https://everyapp.com/docs/agent/ai (in the checkout
  `landing-page/content/agent/ai.md`): the route, the order, the
  commands and their `--json`, the event.
- `packages/sdk/src/internal/aiDefault.ts`: the resolution rule.
