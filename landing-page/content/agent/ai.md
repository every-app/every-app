---
title: "AI: the default model provider and AI Gateway"
description: "How an app gets a chat model without naming a provider: the manifest's ai.chat, the SDK's ai(), the /api/ai/default route, the order the Gateway resolves the default in (OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral, Gemini), everyapp ai default|show|list|gateway with their --json data and the MCP twins, Cloudflare AI Gateway in front of every provider, what each AI entry's fields mean, the usage by model, the ai.default_changed event, and why OpenRouter is the first default and AI Gateway is never one."
---

Two ways an app reaches a model through the Gateway. It **pins a provider**: lists `openrouter` (or any `ai` entry of [the catalog](/docs/agent/providers#the-catalog)) under `providers`, calls `/api/ai/openrouter/…` with `createGatewayFetch()`, and names the model itself ([the identity page](/docs/agent/identity#ai-creategatewayfetch)). Or it **takes the default**: says `ai: { chat: true }` in `everyapp.config.ts`, calls `/api/ai/default/v1/chat/completions` with the SDK's `ai()`, and the Gateway's operator decides which provider and model that is. The second is for an app that needs "a model" rather than one vendor (a draft writer, a summarizer, a research agent), so that a person installing four such apps sets one key, not one per app. The design and its decisions are in the repository's docs/design/2026-10-model-providers.md.

## What an app writes

```ts
// everyapp.config.ts
export default {
  id: "inbox",
  ai: { chat: { why: "Drafts replies and summarizes threads." } },
} as const;
```

`ai.chat` is `true`, or an entry with the need fields of [the settings model](/docs/agent/manifest#required-optional-or-one-of-a-group) (`why`, `docs`, `optional`, `anyOf`). It is a Gateway setting in that model, of kind `ai-default`, labelled "A chat model (OpenRouter)" (the provider the default resolves to now): the app shows "Needs setup" until any one model provider's key is set, and the setup dialog, `everyapp status`, `secret list` and `configure` ask for the first provider's key (`OPENROUTER_API_KEY`) and name the alternatives, from the same resolution the route uses. The `ai.models` allowlist doesn't apply to the default route: the operator chose the model. An app may do both, pin a provider for one feature and take the default for another.

```ts
import OpenAI from "openai";
import { ai } from "@every-app/sdk/server";

const { baseURL, fetch, model } = ai({ env });
const client = new OpenAI({ baseURL, fetch, apiKey: "gateway-managed" });
const answer = await client.chat.completions.create({
  model, // "default": the Gateway puts the operator's model in
  messages: [{ role: "user", content: "Summarize this thread." }],
});
```

`ai({ env, for? })` returns `{ baseURL, fetch, model, chatCompletionsUrl, embeddingsUrl }`: `baseURL` is `AI_DEFAULT_BASE_URL`, `http://every-app-gateway.internal/api/ai/default/v1`; `fetch` is `createGatewayFetch({ env, for })`; `model` is the string `default`. A request that names no `model`, or names `default`, gets the resolved model; a request that names another model sends it as it is (the operator's provider must serve it). `for` is the attribution every Gateway call carries, taken from the request context when left out ([attribution](/docs/agent/identity#attribution)). Any OpenAI-compatible client (`openai`, `@ai-sdk/openai-compatible`, a plain `fetch` to `chatCompletionsUrl`) works the same way.

**Local development.** With no Gateway binding and `EVERYAPP_DEV` set, `/api/ai/default/…` resolves on the developer's own `.dev.vars` by the same order below (the first provider whose settings are all set) and the SDK calls that provider directly with the model filled in. With none set: `ConfigurationError`, `Set OPENROUTER_API_KEY (or another model provider's key) in .dev.vars to call the default model in local development.`

## Code written for `env.AI`: `gatewayAiBinding()`

Code that calls Workers AI's binding, `env.AI.run(model, inputs, options)` (upstream code a port keeps, `workers-ai-provider`, the Agents SDK), takes `gatewayAiBinding(env, { for, provider, models })` from `@every-app/sdk/server` in place of `env.AI`. It returns the app's own `Ai` type (the Workers types `cf workers types` generates), so it goes wherever `env.AI` went with no cast, and every call goes through the Gateway: capped, counted and kept to `ai.models` like any provider call. The app lists the provider under `providers` (`workers-ai` by default) and needs no `resources.ai` binding.

```ts
import { gatewayAiBinding } from "@every-app/sdk/server";

const AI = gatewayAiBinding(env, { for: request });
const { response } = await AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
  messages: [{ role: "user", content: "Is this email spam? YES or NO." }],
  max_tokens: 10,
});
// upstream code that reads env.AI unchanged:
return app.fetch(request, { ...env, AI }, ctx);
```

`packages/sdk/src/server/aiBinding.ts`. Each `run()` is an OpenAI-compatible call through `createGatewayFetch({ env, for })` on the provider's route (`/api/ai/<provider>` plus the entry's `chat.path` or `embeddings.path`), answered in Workers AI's shapes:

| `run()` with                             | Goes to                                                                                                                                                                                                 | Answers                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages` or `prompt` (text generation) | chat completions; `prompt` as one user message, legacy tools (`{ name, description, parameters }`) as OpenAI's, every other input (`max_tokens`, `temperature`, `response_format`, `tools`, …) as it is | `{ response, tool_calls?, usage? }`: `response` the text (an all-digit reply a string), each tool call in both forms Workers AI answers with (`{ name, arguments }`, arguments parsed, and `{ id, type, function }`) |
| … and `stream: true`                     | the same, streamed                                                                                                                                                                                      | a `ReadableStream` of `data: {"response": "<token>"}` events (tool call deltas and usage alongside), then `data: [DONE]`                                                                                             |
| `text` (embeddings)                      | embeddings, `{ model, input: text }`                                                                                                                                                                    | `{ shape: [rows, dimensions], data }`                                                                                                                                                                                |
| `options.returnRawResponse: true`        | as above                                                                                                                                                                                                | the provider's own `Response`, OpenAI-shaped (not Workers AI's)                                                                                                                                                      |

Anything else throws `ConfigurationError` before any call (`<what> isn't available through the Every App gateway; call the provider's routes with createGatewayFetch() instead.`): other tasks (images, audio, `requests` batches), `websocket: true`, and the binding's other methods (`gateway()`, `autorag()`, `aiSearch()`, `websearch()`, `models()`, `toMarkdown()`). `options.gateway` is ignored: whether calls go through Cloudflare AI Gateway is the operator's setting (below). A refusal throws `GatewayRefusalError` with the Gateway's code (`ai_provider_not_configured`, `model_not_allowed`, …), a provider error throws `Error` (`AI (workers-ai) answered 400: …`), and no binding and no dev key throws createGatewayFetch's `ConfigurationError`, all from `run()`: making the binding checks nothing, so one per request costs nothing.

Options: `for` (createGatewayFetch's); `provider`, default `workers-ai` so `@cf/…` ids work as they are, or any `ai` entry with OpenAI-compatible routes (`openrouter`, `openai`, …), or `default` (the operator's model, `ai: { chat: true }`), where an `@cf/…` id is sent as `default`; `models`, a map from the ids the code names to the ids to send (`{ "@cf/meta/llama-3.1-8b-instruct-fast": "meta-llama/llama-3.1-8b-instruct" }` with `provider: "openrouter"`), anything unlisted sent as it is. A provider without the route throws `ConfigurationError` (`anthropic has no OpenAI-compatible embeddings route.`). In local development it reaches the provider with the developer's own key in `.dev.vars` (`WORKERS_AI_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for Workers AI), as createGatewayFetch does.

Why the app's own `Ai` and not a type of the SDK's: `Ai` changes with each Workers types version (`run()`'s overloads, new methods), and the app's `Env` names its own. The declaration says `Ai`, which resolves to the app's version; the object implements `run()` and throws on the rest. The model names `run()` accepts are the app's types', exactly as with a real binding.

## The route: `/api/ai/default`

The Gateway serves two paths under it, both OpenAI-shaped: `/v1/chat/completions` and `/v1/embeddings`. Each maps onto the resolved provider's own route for it (the entry's `chat` and `embeddings` blocks: OpenRouter's `/api/v1/chat/completions`, Workers AI's `/v1/chat/completions` under the account path, Groq's `/openai/v1/chat/completions`), with every rule of that provider's entry (`store: false` where it applies, the credential headers stripped, the usage tap). Then:

| Refusal                     | Status | When                                                                                                                                                                                                                                          |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_not_allowed`      | 403    | The manifest doesn't say `ai.chat` (`The app manifest does not ask for the default model: set ai: { chat: true } (or list a provider under providers).`)                                                                                      |
| `ai_default_not_configured` | 503    | Nothing is configured, or the operator's choice isn't: the message names the settings to set (`the gateway needs OPENROUTER_API_KEY`) and `everyapp ai default <provider>`; the app shows it where it would show `ai_provider_not_configured` |
| `ai_route_not_allowed`      | 403    | Any other path (`The default route serves /v1/chat/completions and /v1/embeddings only; for anything else list the provider under providers and call /api/ai/<provider>/…`)                                                                   |
| the provider's own          |        | After that, as on `/api/ai/<provider>`                                                                                                                                                                                                        |

The usage counters count the call against the provider it went to (never `default`), with the model: Manage workspace → Usage shows provider and model, and `workspace usage --json` carries `byModel` (`{ provider, model, calls, failures, inputTokens, outputTokens, costMicros }`, most calls first) beside `byTarget`. The log line `ai.proxy.request` carries `provider` (the resolved one), `via: "default"` and `source` (`setting`, `order` or `none`).

## How the default resolves

`resolveAiDefault()` in `packages/sdk/src/internal/aiDefault.ts`, run by the Gateway on every default-route call (the organization's choice cached 30 seconds per isolate), by `everyapp ai show`, and by the settings model:

1. **The operator's choice**, when one is stored (`everyapp ai default <provider>[/<model>]`, or Manage workspace → Usage → AI default; `org_settings.ai_default`): that provider, and that model when the choice names one, else the entry's. The choice wins even while its key isn't set: the route refuses with `ai_default_not_configured` naming the key, and setup asks for it. A choice the default can't be (an API provider, Cohere, AI Gateway) is reported as a problem and the order decides.
2. **Else the shipped order**, the first provider whose Gateway settings are all set: `openrouter`, `workers-ai`, `openai`, `anthropic`, `groq`, `mistral`, `gemini`.
3. **Else** nothing is configured: the first of the order (OpenRouter) is what setup asks for, and the route refuses.

Why that order. OpenRouter is one key in front of many models, prepaid, with the call's price in every answer (`usage.cost`, read into the counters): the one key that makes every app work and the only one whose spend the Gateway can count in dollars. Workers AI is second because it needs no provider account at all (the Gateway's own Cloudflare token and account), at the cost of weaker models. Then the single-vendor keys, cheapest capable model first. Cohere has a chat route in its own shape, so it is pinned by an app, never a default. **Cloudflare AI Gateway is never a default**: it has no models of its own and needs an upstream key (or Workers AI); it is a proxy in front of whichever provider the default resolves to, below. So the right default for an operator who has both is "OpenRouter through AI Gateway", else OpenRouter, else Workers AI, which is what the shipped order and the setup text say.

The models the Gateway fills in when the app names none (each entry's `chat.model`; the operator overrides with `ai default <provider>/<model>`): OpenRouter `anthropic/claude-haiku-5.5`, Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct`, OpenAI `gpt-6-luna`, Anthropic `claude-haiku-5-5` (its OpenAI-compatible endpoint, which Anthropic documents as not a long-term solution), Groq `openai/gpt-oss-20b`, Mistral `mistral-small-latest`, Gemini `gemini-3.1-flash-lite`. Embeddings (`embeddings.model`): OpenRouter `openai/text-embedding-3-small`, Workers AI `@cf/baai/bge-m3`, OpenAI `text-embedding-3-small`, Mistral `mistral-embed`, Gemini `gemini-embedding-001`; Anthropic and Groq have none, so `/v1/embeddings` on them is `ai_route_not_allowed`.

## Cloudflare AI Gateway in front

AI Gateway is Cloudflare's proxy for model calls: logs, caching, rate limits, retries and a spend view per gateway, at `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/<provider slug>/…`. It carries each provider's own key through; it is not a provider. On an EveryApp Gateway it is one setting: with `AI_GATEWAY_ID` set (and the install's `CLOUDFLARE_ACCOUNT_ID`), **every call to an AI provider whose entry has an AI Gateway slug goes through it**, direct routes and the default route alike, the provider's key still on the call; a provider without a slug goes direct. `everyapp ai gateway on` creates the gateway (`everyapp` by default) in the operator's account and records its id; `everyapp ai gateway off` clears it. An authenticated gateway's token goes in `AI_GATEWAY_API_KEY` (`everyapp secret set AI_GATEWAY_API_KEY`), sent as `cf-aig-authorization: Bearer <token>`; apps can't set it or any `cf-aig-*` header (the proxy strips them, as before).

How each provider is fronted (the entry's `aig` block, from Cloudflare's provider pages on 2026-10-25): `openrouter` as `openrouter` with the direct path's `/api` dropped (`…/openrouter/v1/chat/completions`), `openai` as `openai` with `/v1` dropped, `groq` as `groq` with `/openai/v1` dropped, `anthropic` as `anthropic` and `mistral` as `mistral` with the path kept, `workers-ai` on its own URL with `cf-aig-gateway-id: <id>` (Workers AI's REST API is AI Gateway's host). `gemini` and `cohere` have no documented AI Gateway form for their OpenAI-shaped paths, so they go direct even with the gateway on. The catalog entry `ai-gateway` (kind `proxy`) is never listed under `providers` and never a default (`ai_provider_not_supported` by id).

## What an `ai` entry says

Beside the fields every AI entry had ([the providers page](/docs/agent/providers)), the model-providers fields, in `AiProviderCapability` (`packages/sdk/src/internal/capabilities.ts`):

| Field          | What it says                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`        | The request shape its inference routes take: `openai` (chat completions and the compatible family), `anthropic` (Messages), `other` (Cohere's v2). Absent: `openai`.                        |
| `chat`         | `{ path, model }`: the entry's chat route the default maps `/v1/chat/completions` onto, and the model filled in when the app names none. An entry without it can't be the default.          |
| `embeddings`   | `{ path, model }`: the same for `/v1/embeddings`.                                                                                                                                           |
| `aig`          | `{ slug, trim?, header? }`: how AI Gateway fronts it (the slug, the direct prefix the gateway's URL drops, or a header on the provider's own URL). Absent: direct even with the gateway on. |
| `authOptional` | The key setting is read when set and the entry works without it (AI Gateway's own token). Never a need.                                                                                     |
| `kind`         | `proxy`: fronts the other entries, serves no models (AI Gateway).                                                                                                                           |

`inferenceRoutes`, `unstoredRoutes`, `extraRoutes`, `normalize`, `cost.responseField`, `origin`, `basePath` and `alsoNeeds` are as before. A registered row never carries an `ai` entry (the spec parser refuses `mode: "ai"`, as it did).

## The commands

All under `everyapp ai`, under the Cloudflare login like every registry change, writing the install organization's `org_settings` row; with `--json`, one event per line and `done.data` as below.

| Command                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai show`                         | What the default resolves to now and why: `done.data` is the resolution (`provider`, `label`, `model`, `source`: `setting`, `order` or `none`, `configured`, `settings`, `via`: `ai-gateway` or `direct`, `candidates[]` with `id`, `label`, `settings`, `configured`, `model`, `viaAiGateway`, `embeddings`, and `problem` when the stored choice can't serve) plus `aiGateway: { on }` (whether `AI_GATEWAY_ID` and the account are set; the id itself is a setting and isn't read back). Reads the Gateway's secret names, never values. |
| `ai list`                         | Every provider the default could be, in the order, each with whether its settings are set: `done.data.candidates`, the same shape.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ai default <provider>[/<model>]` | Store the choice (`openrouter`, `openrouter/anthropic/claude-sonnet-5.5`, `groq/openai/gpt-oss-120b`); refused for an id the catalog doesn't have, an API provider, an entry without a chat route or AI Gateway (`AI_DEFAULT_INVALID`, naming what to pick). A provider whose key isn't set is accepted with a warning naming the key. Queues `ai.default_changed` when the choice changed. `done.data`: the new resolution.                                                                                                                |
| `ai default off`                  | Clear the choice: the order decides again. Queues `ai.default_changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ai gateway on [--id <name>]`     | Find or create the AI Gateway `everyapp` (or `--id`) in the Gateway's Cloudflare account and record its id in `AI_GATEWAY_ID`; from then on every slugged provider goes through it. `done.data`: `{ id, url, created }`.                                                                                                                                                                                                                                                                                                                    |
| `ai gateway off`                  | Unset `AI_GATEWAY_ID`; the Cloudflare resource stays. `AI_GATEWAY_API_KEY` stays until `secret unset`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The MCP twins on the Gateway's own `/mcp` ([the workspace page](/docs/agent/workspace)): `everyapp_ai_show` (any member; whether each setting is set shows to owners and admins) and `everyapp_ai_default` (owners and admins; `provider` and optional `model`, or `clear: true`). The AI Gateway switch is the terminal's (it creates a Cloudflare resource under the operator's login). The matrix row is in docs/design/2026-10-agent-parity.md.

## The event

`ai.default_changed` ([the events page](/docs/agent/events#the-default-model-provider)): `{ aiDefault: { provider, model } | null, previous: { provider, model } | null }`, `null` for the shipped order; from the UI, the CLI and the tool, only when the stored choice changed.

## The answer to "why not AI Gateway everywhere"

Because AI Gateway is a proxy with no models of its own: it needs an upstream provider's key (or Workers AI in the same account) on every call, so making it "the default" would still leave the question of which key. OpenRouter is one key for many models and reports each call's price, which is what a person installing four apps wants to set once. The best of both, when the operator has both, is OpenRouter through AI Gateway: the one key, plus Cloudflare's logs, caching and limits on every call. That is the shipped default order and what the setup text says; `everyapp ai gateway on` is one command and changes no app.

## Sources

`packages/sdk/src/internal/aiDefault.ts` (the resolution), `packages/sdk/src/internal/capabilities.ts` and `packages/sdk/src/internal/catalog/inference.ts` (the entries), `packages/sdk/src/server/ai.ts` (`ai()`), `packages/sdk/src/server/aiBinding.ts` (`gatewayAiBinding()`), `apps/every-app-gateway/src/server/ai-proxy.ts` (the route and AI Gateway), `apps/every-app-gateway/src/server/ai-default.ts` (the cached choice), `apps/every-app-gateway/src/server/ai-default.test.ts` and `apps/every-app-gateway/src/server/ai-provider-pins.test.ts` (the bytes), `packages/cli/skills/everyapp/setup/ai.md` and `packages/cli/skills/everyapp/setup/ai-gateway.md` (the setups), docs/design/2026-10-model-providers.md.
