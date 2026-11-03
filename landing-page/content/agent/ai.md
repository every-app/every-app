---
title: "AI: the default model and AI Gateway"
description: "How an app gets a chat model without naming a provider: the manifest's ai.chat, the /api/ai/default route called with aiBaseUrl() and createGatewayFetch(), the workspace's one default-model setting (<provider>[/<model>]) and the order the Gateway falls back to (OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral, Gemini), the catalog's models, everyapp ai show|default|gateway with their --json data and the MCP twins, Cloudflare AI Gateway in front of every provider, what each AI entry's fields mean, the usage by model, the ai.default_changed event, and why OpenRouter is the first default and AI Gateway is never one."
metaTitle: "AI providers and Cloudflare AI Gateway"
metaDescription: "How an EveryApp app gets a chat model without naming a provider: the workspace's default model, the order it falls back to, and Cloudflare AI Gateway."
---

Two ways an app reaches a model through the Gateway. It **pins a provider**: lists `openrouter` (or any `ai` entry of [the catalog](/docs/agent/providers#the-catalog)) under `providers`, calls `/api/ai/openrouter/…` with `createGatewayFetch()`, and names the model itself ([the identity page](/docs/agent/identity#ai-creategatewayfetch)). Or it **takes the default**: says `ai: { chat: true }` in `everyapp.config.ts`, calls `/api/ai/default/v1/chat/completions` with `createGatewayFetch()`, and the workspace's default model decides which provider and model that is. The second is for an app that needs "a model" rather than one vendor (a draft writer, a summarizer, a research agent), so that a person installing four such apps sets one key, not one per app. The design and its decisions are in the repository's docs/design/2026-10-model-providers.md.

## What an app writes

```ts
// everyapp.config.ts
export default {
  id: "inbox",
  ai: { chat: { why: "Drafts replies and summarizes threads." } },
} as const;
```

`ai.chat` is `true`, or an entry with the need fields of [the settings model](/docs/agent/manifest#required-optional-or-one-of-a-group) (`why`, `docs`, `optional`, `anyOf`). It is a Gateway setting in that model, of kind `ai-default`, labelled "A chat model (OpenRouter)" (the provider the default resolves to now): the app shows "Needs setup" until any one model provider's key is set, and the setup dialog, `everyapp status`, `secret list` and `configure` ask for the first provider's key (`OPENROUTER_API_KEY`) and name the alternatives, from the same resolution the route uses. The `ai.models` allowlist doesn't apply to the default route: the workspace chose the model. An app may do both, pin a provider for one feature and take the default for another.

```ts
import OpenAI from "openai";
import { aiBaseUrl, createGatewayFetch } from "@every-app/sdk/server";

const client = new OpenAI({
  baseURL: aiBaseUrl(), // http://every-app-gateway.internal/api/ai/default/v1
  fetch: createGatewayFetch({ env }),
  apiKey: "gateway-managed",
});
const answer = await client.chat.completions.create({
  model: "default", // the Gateway puts the workspace's model in
  messages: [{ role: "user", content: "Summarize this thread." }],
});
```

`aiBaseUrl()` with no argument is the default route's base, `http://every-app-gateway.internal/api/ai/default/v1`; `createGatewayFetch({ env, for? })` is the fetch every Gateway call takes. A request that names no `model`, or names `default`, gets the resolved model (below); a request that names another model sends it as it is (the provider must serve it). `for` is the attribution every Gateway call carries, taken from the request context when left out ([attribution](/docs/agent/identity#attribution)). Any OpenAI-compatible client (`openai`, `@ai-sdk/openai-compatible`, a plain `fetch` to `${aiBaseUrl()}/chat/completions`) works the same way.

**Local development.** With no Gateway binding and `EVERYAPP_DEV` set, `/api/ai/default/…` resolves on the developer's own `.dev.vars` by the same order below (the first provider whose settings are all set) and the SDK calls that provider directly with its catalog model filled in (dev has no workspace setting; name a model in the request to try another). With none set: `ConfigurationError`, `Set OPENROUTER_API_KEY (or another model provider's key) in .dev.vars to call the default model in local development.`

**When nothing is set up.** A call refused for want of a key answers `ai_default_not_configured` (or `ai_provider_not_configured` on a pinned provider) with [setup info](/docs/agent/identity#setup-info-what-to-set-in-the-gateways-words): `refusalFromError(error)` reads it from whatever client threw, and its `setup` is the sentence to show ([refusals](/docs/agent/identity#refusals)). An app that wants to hide an AI feature up front checks for the code on its first call; there is no separate status call.

## The route: `/api/ai/default`

The Gateway serves two paths under it, both OpenAI-shaped: `/v1/chat/completions` and `/v1/embeddings`. Each maps onto the resolved provider's own route for it (the entry's `chat` and `embeddings` blocks: OpenRouter's `/api/v1/chat/completions`, Workers AI's `/v1/chat/completions` under the account path, Groq's `/openai/v1/chat/completions`), with every rule of that provider's entry (`store: false` where it applies, the credential headers stripped, the usage tap). Then:

| Refusal                     | Status | When                                                                                                                                                                                                                                |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_not_allowed`      | 403    | The manifest doesn't say `ai.chat` (`The app manifest does not ask for the default model: set ai: { chat: true } (or list a provider under providers).`)                                                                            |
| `ai_default_not_configured` | 503    | Nothing is configured, or the chosen provider isn't: [setup info](/docs/agent/identity#setup-info-what-to-set-in-the-gateways-words) names the provider's settings, `everyapp configure <app>` and `everyapp ai default <provider>` |
| `ai_route_not_allowed`      | 403    | Any other path (`The default route serves /v1/chat/completions and /v1/embeddings only; for anything else list the provider under providers and call /api/ai/<provider>/…`)                                                         |
| the provider's own          |        | After that, as on `/api/ai/<provider>`                                                                                                                                                                                              |

The usage counters count the call against the provider it went to (never `default`), with the model: Manage workspace → Usage shows provider and model, and `workspace usage --json` carries `byModel` (`{ provider, model, calls, failures, inputTokens, outputTokens, costMicros }`, most calls first) beside `byTarget`. The log line `ai.proxy.request` carries `provider` (the resolved one), `via: "default"` and `source` (`setting`, `order` or `none`).

## How the default resolves

`resolveAiDefault()` in `packages/sdk/src/internal/aiDefault.ts`, run by the Gateway on every default-route call (the organization's setting cached 30 seconds per isolate), by `everyapp ai show`, and by the settings model. The workspace has one AI setting, `<provider>[/<model>]` (`everyapp ai default`, Manage workspace → Usage → AI default, the `everyapp_ai_default` tool; stored in `org_settings.ai_default`):

1. **The setting**, when there is one: that provider, with the setting's model, else the provider's catalog model. The setting wins even while its key isn't set: the route refuses with `ai_default_not_configured` naming the key, and setup asks for it. A setting the default can't be (an API provider, Cohere, AI Gateway, a provider since removed) is reported as a problem and the order decides.
2. **Else the shipped order**, the first provider whose Gateway settings are all set, with its catalog model: `openrouter`, `workers-ai`, `openai`, `anthropic`, `groq`, `mistral`, `gemini`.
3. **Else** nothing is configured: the first of the order (OpenRouter) is what setup asks for, and the route refuses.

Why that order. OpenRouter is one key in front of many models, prepaid, with the call's price in every answer (`usage.cost`, read into the counters): the one key that makes every app work and the only one whose spend the Gateway can count in dollars. Workers AI is second because it needs no provider account at all (the Gateway's own Cloudflare token and account), at the cost of weaker models. Then the single-vendor keys, cheapest capable model first. Cohere has a chat route in its own shape, so it is pinned by an app, never a default. **Cloudflare AI Gateway is never a default**: it has no models of its own and needs an upstream key (or Workers AI); it is a proxy in front of whichever provider the default resolves to, below. So the right default for an operator who has both is "OpenRouter through AI Gateway", else OpenRouter, else Workers AI, which is what the shipped order and the setup text say.

## The models

When the app names no model (or `default`), the Gateway fills in the chat model of the workspace's setting (`ai default openrouter/anthropic/claude-sonnet-5.5`), else the provider's catalog model (the entry's `chat.seedModel`). Embeddings always use the provider's catalog model (`embeddings.seedModel`); an app that needs another embeddings model pins the provider and names it. `ai show` lists every candidate with its catalog models. Only `resolveAiDefault()` reads them.

The catalog models (what serves where the setting names no model): OpenRouter `anthropic/claude-haiku-5.5`, Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct`, OpenAI `gpt-6-luna`, Anthropic `claude-haiku-5-5` (its OpenAI-compatible endpoint, which Anthropic documents as not a long-term solution), Groq `openai/gpt-oss-20b`, Mistral `mistral-small-latest`, Gemini `gemini-3.1-flash-lite`. Embeddings (`embeddings.model`): OpenRouter `openai/text-embedding-3-small`, Workers AI `@cf/baai/bge-m3`, OpenAI `text-embedding-3-small`, Mistral `mistral-embed`, Gemini `gemini-embedding-001`; Anthropic and Groq have none, so `/v1/embeddings` on them is `ai_route_not_allowed`.

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

A registered row can be an `ai` entry too: `pnpm everyapp provider add <spec.json>` with `mode: "ai"` (its `baseUrl`, the key's placement, `models` and `defaultModel`; [/docs/agent/providers](/docs/agent/providers#mode-ai-an-openai-compatible-model-provider)). The proxy serves it with the same rules (inference POSTs on its routes alone, `store: false` on chat, the model allowlist, the usage tap, AI Gateway never in front since a row has no `aig` slug), refuses a model outside its `models`, and reads its key only while the row is bound (`everyapp secret set <KEY>` after `provider add`). Apps pin it under `providers` and call `/api/ai/<id>/…`; `everyapp ai default <id>` may choose it, and `ai show` lists it after the catalog's entries.

## The commands

All under `everyapp ai`. `show` and `default` are the Gateway's tools below (`everyapp_ai_show`, `everyapp_ai_default`), run as you through its admin API like the `workspace` commands ([workspace](/docs/agent/workspace#the-cli-everyapp-workspace)), so a refusal is `GATEWAY_TOOL_ERROR` with the Gateway's code in `data.code`; `gateway on|off` works under the Cloudflare login, since it makes a Cloudflare resource and sets a Gateway setting. With `--json`, one event per line and `done.data` as below.

| Command                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai show`                         | What the default resolves to now and why, then every provider it could be: `done.data` is the resolution (`provider`, `label`, `model`, `embeddingsModel`, `choice`: the stored setting or `null`, `source`: `setting`, `order` or `none`, `configured`, `settings`, `via`: `ai-gateway` or `direct`, `candidates[]` in the order with `id`, `label`, `settings`, `configured`, `model` and `embeddingsModel` (the catalog's), `viaAiGateway`, `embeddings`, and `problem` when the stored setting can't serve) plus `aiGateway: { on }` (whether `AI_GATEWAY_ID` and the account are set; the id itself is a setting and isn't read back). Reads the Gateway's secret names, never values. |
| `ai default <provider>[/<model>]` | Store the setting (`openrouter`, `openrouter/anthropic/claude-sonnet-5.5`, `groq/openai/gpt-oss-120b`; without a model the provider's catalog model serves); refused for an id the catalog doesn't have, an API provider, an entry without a chat route, AI Gateway or a model that isn't a model id (a `GATEWAY_TOOL_ERROR` naming what to pick; an argument that isn't `provider[/model]` is `AI_DEFAULT_INVALID` before anything is sent). A provider whose key isn't set is accepted: the resolution says `configured: false` and names the key in `settings`. Queues `ai.default_changed` when the setting changed. `done.data`: the new resolution.                                   |
| `ai default off`                  | Clear the setting: the order decides again. Queues `ai.default_changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ai gateway on [--id <name>]`     | Find or create the AI Gateway `everyapp` (or `--id`) in the Gateway's Cloudflare account and record its id in `AI_GATEWAY_ID`; from then on every slugged provider goes through it. `done.data`: `{ id, url, created }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ai gateway off`                  | Unset `AI_GATEWAY_ID`; the Cloudflare resource stays. `AI_GATEWAY_API_KEY` stays until `secret unset`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The MCP twins on the Gateway's own `/mcp` ([the workspace page](/docs/agent/workspace)): `everyapp_ai_show` (any member; whether each setting is set shows to owners and admins) and `everyapp_ai_default` (owners and admins; `provider` and optional `model`, or `clear: true`). Manage workspace → Usage → AI default is the UI's. The AI Gateway switch is the terminal's (it creates a Cloudflare resource under the operator's login). The matrix row is in docs/design/2026-10-agent-parity.md.

## The event

`ai.default_changed` ([the events page](/docs/agent/events#the-default-model-provider)): `{ aiDefault: { provider, model } | null, previous: { provider, model } | null }`, `null` for the shipped order, `model` the setting's model (`null`: the provider's catalog model); from the UI, the CLI and the tool, only when the stored setting changed.

## The answer to "why not AI Gateway everywhere"

Because AI Gateway is a proxy with no models of its own: it needs an upstream provider's key (or Workers AI in the same account) on every call, so making it "the default" would still leave the question of which key. OpenRouter is one key for many models and reports each call's price, which is what a person installing four apps wants to set once. The best of both, when the operator has both, is OpenRouter through AI Gateway: the one key, plus Cloudflare's logs, caching and limits on every call. That is the shipped default order and what the setup text says; `everyapp ai gateway on` is one command and changes no app.

## Sources

`packages/sdk/src/internal/aiDefault.ts` (the resolution), `packages/sdk/src/internal/capabilities.ts` and `packages/sdk/src/internal/catalog/inference.ts` (the entries), `packages/sdk/src/server/ai.ts` (`aiBaseUrl()`), `packages/sdk/src/server/gatewayFetch.ts` (`createGatewayFetch()` and its local-development fallback), `apps/every-app-gateway/src/server/ai-proxy.ts` (the route and AI Gateway), `apps/every-app-gateway/src/server/ai-default.ts` (the cached setting), `apps/every-app-gateway/src/server/ai-default.test.ts` and `apps/every-app-gateway/src/server/ai-provider-pins.test.ts` (the bytes), `packages/cli/skills/everyapp/setup/ai.md` and `packages/cli/skills/everyapp/setup/ai-gateway.md` (the setups), docs/design/2026-10-model-providers.md.
