---
title: "AI: the default model and AI Gateway"
description: "How an app gets a model through the Gateway (the workspace default or a pinned provider), the workspace's one default-model setting and how it resolves, everyapp ai show|default|gateway, and Cloudflare AI Gateway in front."
---

An app reaches a model through the Gateway two ways, and never holds a key. Both use `createGatewayFetch()`, the one way to call a model:

- **Take the default.** The manifest says `ai: { chat: true }` (or `{ why, optional, … }`) and the app calls `/api/ai/default/v1` with model `default`. The workspace's default model picks the provider and model, for every app.
- **Pin a provider.** The manifest lists `providers: ["openrouter"]` and the app calls `/api/ai/openrouter/…`, naming the model itself.

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

`aiBaseUrl("openrouter")` is a pinned provider's base. The default route serves `/v1/chat/completions` and `/v1/embeddings` only. Refusals: `provider_not_allowed` (the manifest doesn't ask for it), `ai_default_not_configured` (no key set: setup info names it), `ai_route_not_allowed`. Pinned providers keep their own rules: inference routes only, plus the OpenAI paths the manifest's `ai.routes` names; `ai.models` enforced; `store: false` on chat.

## When nothing is set up

A call refused for want of a key answers `ai_default_not_configured` (or `ai_provider_not_configured` on a pinned provider) with setup info. `refusalFromError(error)` reads it from whatever client threw; show its `setup` instead of the feature. There is no separate status call. [identity](/docs/agent/identity#setup-info-what-to-set-in-the-gateways-words)

```ts
const refusal = refusalFromError(error);
if (refusal?.code === "ai_default_not_configured" || refusal?.code === "ai_provider_not_configured")
  return { aiOff: true, setup: refusal.setup, command: refusal.command };
```

## How the default resolves

The workspace has one AI setting, `<provider>[/<model>]` (`everyapp ai default`, Manage workspace → Usage → AI default, or `everyapp_ai_default`).

1. The setting, when there is one: that provider, with the setting's model or else the provider's catalog model. It wins even while its key is unset; then calls refuse and setup asks for that key.
2. Otherwise the first provider whose key is set, in this order: `openrouter`, `workers-ai`, `openai`, `anthropic`, `groq`, `mistral`, `gemini`, with its catalog model.
3. Otherwise nothing; setup asks for OpenRouter.

OpenRouter is first because it's one prepaid key in front of many models and reports each call's price, so dollar caps work. Workers AI is next because it needs no provider account. AI Gateway is not a provider and never the default. Embeddings always use the provider's catalog model; an app that needs another pins the provider and names it. An app that names a model gets that model.

## The commands

| Command | Does |
|---|---|
| `everyapp ai show` | What the default resolves to now, why, and every provider it could be, with their catalog models. |
| `everyapp ai default <provider[/model]\|off>` | Set or clear the workspace setting (`AI_DEFAULT_INVALID` for an argument that isn't `provider[/model]`; the Gateway's refusals come back as `GATEWAY_TOOL_ERROR`). |
| `everyapp ai gateway on [--id <id>]`, `everyapp ai gateway off` | Put Cloudflare AI Gateway in front, or take it away (under the Cloudflare login). |

`show` and `default` are the Gateway's tools, run as you like the `workspace` commands ([workspace](/docs/agent/workspace)). From an AI client: `everyapp_ai_show`, `everyapp_ai_default`. Keys go in with `everyapp provider add openrouter` or `everyapp secret set OPENROUTER_API_KEY`; guides [setup/openrouter](/docs/agent/setup/openrouter), [setup/openai](/docs/agent/setup/openai), [setup/workers-ai](/docs/agent/setup/workers-ai). A change queues `ai.default_changed`.

## Cloudflare AI Gateway in front

`everyapp ai gateway on` creates or reuses an AI Gateway (default id `everyapp`) and sets `AI_GATEWAY_ID`; from then on every call to a provider AI Gateway supports goes through it, with logs, caching and a spend view in the dashboard. Each provider's own key still authorizes the call; Gemini and Cohere go direct. `AI_GATEWAY_API_KEY` is for an authenticated gateway. `everyapp ai gateway off` goes direct again. An app wanting a gateway of its own declares `resources.aiGateway`. To use Workers AI with the account's own binding instead of the Gateway, declare `resources.ai`.

## Usage and caps

Each call counts against the provider it went to (never `default`), with the model and tokens, and against the app's monthly dollar cap. Manage workspace → Usage and `everyapp workspace usage` show it. A capped app's calls answer `429 app_monthly_cap_exceeded`. [workspace](/docs/agent/workspace)

## Local development

With no Gateway, the default resolves on `.dev.vars` by the same order (`OPENROUTER_API_KEY`, …) and the SDK calls the provider directly with its catalog model. With none set, a call throws `ConfigurationError` carrying `ai_provider_not_configured` or `ai_default_not_configured`. `everyapp dev --gateway <url>` uses the real Gateway's keys instead.
