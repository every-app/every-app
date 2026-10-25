# Model providers: the AI entries as data, a per-gateway default, AI Gateway in front

Date: 2026-10-25. Status: built (the pull requests are in section 8). Ben's ask, launch week: "assume we want all of this and build the best, most robust thing we're going to want long term, so that when we launch on Monday people can just run with it." The provider registry ([2026-10-provider-registry.md](2026-10-provider-registry.md), section 11) left one follow-up: "mode: ai rows once the AI proxy's per-route rules are fields". This note finishes that and builds what sits on it: an app says "I need a chat model" and the Gateway answers with whatever its operator configured. The agent-facing reference is [/docs/agent/ai](../../landing-page/content/agent/ai.md); the person-facing page is /docs/ai; the setups are `setup/ai.md` and `setup/ai-gateway.md` in the everyapp skill.

## 1. Ben's question, answered first

"What is the current default for Agentic Inbox? Why would we not use Cloudflare AI Gateway as the default everywhere instead of OpenRouter?"

Before this note, Agentic Inbox had no default: its Worker picked a provider when it was built (`AI_PROVIDER`, Workers AI unless the deploy said `openrouter`), its manifest required OpenRouter's key and listed Workers AI as optional, and OpenCRM required OpenRouter too, so a person installing both set the same key twice and could not switch either to another vendor without a redeploy.

Now the default is resolved, not assumed. **Cloudflare AI Gateway is a proxy with no models of its own**: every call through it still carries an upstream provider's key (or runs on Workers AI in the same account). Making it "the default" would leave the question it can't answer, which key. **OpenRouter is one key for many models** and the only provider whose spend the Gateway can count in dollars (each answer's `usage.cost`). So the right default, when the operator has both, is **OpenRouter through AI Gateway**: the one key, plus Cloudflare's logs, caching and limits on every call; else OpenRouter; else Workers AI, which needs no provider account at all (the Gateway's own Cloudflare token) at the cost of weaker models. That is the shipped order and the setup text. AI Gateway is one switch (`everyapp ai gateway on`) that changes no app and no key.

## 2. The `ai` entry: the proxy's rules as fields

`AiProviderCapability` (`packages/sdk/src/internal/capabilities.ts`) gains, beside `origin`, `basePath`, `alsoNeeds`, `inferenceRoutes`, `unstoredRoutes`, `extraRoutes`, `normalize` and `cost.responseField`:

| Field          | What it says                                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`        | `openai` (chat completions and the compatible family), `anthropic` (Messages), `other` (Cohere's v2). Absent: `openai`. Documentation for apps; the proxy forwards bodies as they are.                                                                                                             |
| `chat`         | `{ path, model }`: the route the default maps `/v1/chat/completions` onto and the model filled in when the app names none. Without it an entry can't be the default.                                                                                                                              |
| `embeddings`   | `{ path, model }`: the same for `/v1/embeddings`.                                                                                                                                                                                                                                                  |
| `aig`          | `{ slug, trim?, header? }`: how Cloudflare AI Gateway fronts the entry: the provider slug under the gateway's URL and the prefix of the direct path the gateway's URL drops (OpenRouter `/api`, OpenAI `/v1`, Groq `/openai/v1`), or, for Workers AI, `header: true` (its own URL plus `cf-aig-gateway-id`). Absent: direct even with the gateway on. |
| `authOptional` | The key is read when set and the entry works without it (AI Gateway's own token). Never a need.                                                                                                                                                                                                    |
| `kind`         | `proxy`: fronts the other entries and serves no models (AI Gateway): never under `providers`, never a default, `ai_provider_not_supported` by id.                                                                                                                                                 |

The entries: OpenAI, OpenRouter and Workers AI (the three built in) get `chat`, `embeddings` and `aig`; Anthropic gets `/v1/chat/completions` (its OpenAI-compatible endpoint, which Anthropic documents as not a long-term solution) as an inference and chat route beside `/v1/messages`, so it can be a default; Groq and Mistral get `chat` (Mistral `embeddings` too) and `aig`; Gemini gets `chat` and `embeddings` but no `aig` (Cloudflare documents only its native form); Cohere gets `shape: "other"` and no `chat` (its OpenAI-compatible endpoint is on another host, `api.cohere.ai`). The new entry `ai-gateway` is the proxy: `origin` `https://gateway.ai.cloudflare.com`, `basePath` `/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_ID}`, `alsoNeeds` both, `auth` a `header` kind on `cf-aig-authorization` with `AI_GATEWAY_API_KEY`, `authOptional`. The AI Gateway paths were read from Cloudflare's provider pages on 2026-10-25 (OpenRouter's page is ambiguous between `/openrouter/chat/completions` and `/openrouter/v1/chat/completions`; its curl example uses the latter, which is what the entry records: a live check is in the TODO).

What stayed code, on purpose: the inference allowlist's enforcement, `store: false`, the model allowlist, the usage tap, Workers AI's response normalizer. They are rules every entry shares; the data says where they apply. A registered row still can't carry `mode: "ai"` (the parser refuses it as before): an AI entry's URL template and its AI Gateway slug are routing a stranger's row should not get to write until the key-binding rule covers them.

**Byte-identical.** `provider-migration.test.ts` (OpenAI, OpenRouter, Workers AI) and the new `ai-provider-pins.test.ts` (Anthropic, Gemini, Mistral, Groq, Cohere, and a refused account-level path), literals captured on main at `7b73d9f6` before the refactor, pass unchanged: with no AI Gateway configured and no `default` route, every existing path sends the same bytes.

## 3. The default route

`/api/ai/default/<path>` is a reserved provider id on the AppGateway entrypoint. It is allowed when the manifest says `ai.chat` (`true`, or an entry with the need fields: `why`, `docs`, `optional`, `anyOf`), else `provider_not_allowed` with a message naming the field. The entrypoint resolves the default for the calling organization (`resolveAiDefault`, below; the organization's stored choice cached 30 s per isolate, `server/ai-default.ts`) and hands the proxy the resolution. The proxy:

1. with no resolution, or one whose provider isn't configured: `503 ai_default_not_configured`, naming the settings and `everyapp ai default <provider>`;
2. maps `/v1/chat/completions` onto the entry's `chat.path` and `/v1/embeddings` onto `embeddings.path`; anything else is `403 ai_route_not_allowed` with the two paths named;
3. fills `model` in (a JSON body with no `model`, `null` or `"default"`; a form body's `model` part the same way) with the resolution's model: the choice's when the operator named one, else the entry's;
4. then everything the entry's own route gets: `store: false` where it applies, the credential headers stripped, the key put on, the usage tap. The `ai.models` allowlist doesn't apply: the operator chose the model.

The call is counted against the provider it went to (never `default`), and, new for every AI call that read a model, in `usage_models` (organization, app, provider, model, month: calls, failures, tokens, cost), which Manage workspace → Usage shows under "By model" and `workspace usage --json` carries as `byModel`. The log line `ai.proxy.request` carries the resolved `provider`, `via: "default"` and `source`.

**The SDK.** `ai({ env, for })` in `@every-app/sdk/server` returns `{ baseURL, fetch, model, chatCompletionsUrl, embeddingsUrl }`: an OpenAI client takes the first two as they are and sends `model: "default"`. In local development with no binding, `createGatewayFetch`'s fallback resolves `/api/ai/default` on `.dev.vars` by the same order and calls that provider directly with the model filled in.

## 4. How the default resolves

`resolveAiDefault({ choice, isSet, lookup })` in `packages/sdk/src/internal/aiDefault.ts`, pure, run by the Gateway (on its env), by `everyapp ai show` (on the Worker's secret names) and by the settings model:

1. the operator's stored choice (`org_settings.ai_default`, `<provider>[/<model>]`; the provider id up to the first slash, the model after it, since model ids hold slashes): that provider and that model, even while its key isn't set (`configured: false`, `settings` says what to set); a choice the default can't be is reported as `problem` and the order decides;
2. else the shipped order, the first whose required settings are all set: `openrouter`, `workers-ai`, `openai`, `anthropic`, `groq`, `mistral`, `gemini`;
3. else nothing is configured: the first of the order, `configured: false`, with its settings: what setup asks for.

`via` is `ai-gateway` when `AI_GATEWAY_ID` and `CLOUDFLARE_ACCOUNT_ID` are set and the entry has an `aig` block. Every candidate carries its state, so every surface lists the same order with the same marks.

**The settings model.** `ai.chat` is a setting of kind `ai-default` (`appSettings`), labelled "A chat model (<the resolved provider>)", whose `names` are the resolved provider's settings and whose new field `alternatives` holds every candidate's settings: it counts as set when any one group is all set, so "Needs setup" asks for one key (`OPENROUTER_API_KEY`) and the hint names the alternatives and `everyapp ai default`. The Gateway's report and the CLI's evaluate it the same way; `everyapp dev` reads it off `.dev.vars`.

## 5. AI Gateway in front

One operator setting, not a per-app choice: with `AI_GATEWAY_ID` set, every call to an entry with an `aig` block, direct routes and the default alike, goes to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/<slug><path minus trim>` (or, Workers AI, its own URL with `cf-aig-gateway-id`), the provider's key still on it, plus `cf-aig-authorization: Bearer <AI_GATEWAY_API_KEY>` when that is set. Apps can't set any `cf-aig-*` header (the proxy strips them, as before). A path that doesn't start with the slug's `trim` goes direct, as it always did. The resource: `everyapp ai gateway on [--id]` finds or makes the gateway in the account (`packages/cli/src/lib/cf/aiGateway.ts`, the Resource provisioners thread's library; `ensureAiGateway`) and sets `AI_GATEWAY_ID` through `applyGatewaySettings`; `off` unsets it. The provisioners thread owns per-app AI Gateways (`resources.aiGateway`), which never touch `AI_GATEWAY_ID`.

Not built: BYOK stored keys (the Gateway always sends the provider's key, so Unified Billing never kicks in), the `compat` endpoint (deprecated for single-model calls by Cloudflare, and OpenRouter isn't on its list), per-request `cf-aig-*` options (cache TTL, metadata: the gateway's dashboard settings apply).

## 6. The commands, the tools, the page, the event

`everyapp ai show | list | default <provider>[/<model>] | default off | gateway on [--id] | gateway off`, writing the install organization's `org_settings` row under the login like `workspace cap default` does, with `GATEWAY_PREDATES_AI_DEFAULT` on a Gateway before migration 0017 and `AI_DEFAULT_INVALID` for a choice the default can't be. The MCP twins `everyapp_ai_show` (any member; `configured` and `settings` to owners and admins only) and `everyapp_ai_default` (owners and admins; `provider`, `model?`, or `clear`). The page: Manage workspace → Usage gets an "AI default" card with a Change dialog (`ai.getAiDefault`, `ai.setAiDefault`) and the "By model" table. The event `ai.default_changed` (`{ aiDefault: { provider, model } | null, previous }`) from all three when the stored choice changed. The parity rows are in [2026-10-agent-parity.md](2026-10-agent-parity.md).

The `org_settings` row now holds two defaults (the cap and the model provider): a write of either keeps the other, and the row is deleted only when both are null (the Gateway's repository, the CLI's `setDefaultMonthlyCap` and `setAiDefault`; a test on each side).

## 7. The apps

Agentic Inbox and OpenCRM each get a pull request in their repository: the manifest says `ai: { chat: { why } }`, the chat model goes through `/api/ai/default/v1` with `model: "default"`, and the provider pin becomes optional (the inbox keeps `AI_PROVIDER` as an explicit pin and for `everyapp dev` on the published SDK; the CRM keeps OpenRouter pinned, optional, for its web research through Perplexity's Sonar models and the OpenRouter-only routing fields, and sends no OpenRouter-only field on the default path). Both wait for `0.3.0-rc.2` of everyapp and the SDK: the published `rc.1`'s strict validator refuses the manifest field `ai.chat`, and its dev fallback doesn't know `default`. The Gateway side needs nothing from the apps: a redeployed app on `rc.1` keeps working as it does today.

## 8. Pull requests

- Platform: this note, the `ai` entry fields and the eight entries, the default route, AI Gateway in front, `usage_models` and `org_settings.ai_default` (migration 0015), `ai.default_changed`, the SDK's `ai()` and dev fallback, `everyapp ai …`, the MCP tools, the Usage page, the agent page, the setups, the user page, the drift tests, TODO.
- Caps in dollars (a follow-up pull request, stacked on this one): a monthly dollar cap beside the call cap, read where a provider reports cost (`org_app_settings.monthly_cost_cap_micros`, `org_settings.default_monthly_cost_cap_micros`, migration 0018; over at either cap; `kind` on the cap events; `--usd` on the two CLI verbs and `costUsd` on the two tools; the defaults taken are in TODO.md "Model providers (2026-10-25)").
- agentic-inbox-everyapp and open-crm: section 7.

## 9. Decisions taken (defaults), and Ben's

Each in TODO.md "Model providers (2026-10-25)" to confirm or change: the shipped order and its reasons; AI Gateway as one operator switch for every slugged provider rather than a per-app or per-provider choice; the operator's choice winning over the order even while its key is unset; `ai.chat` as the manifest shape (not a `default` entry under `providers`); the default serving chat and embeddings only; the `ai.models` allowlist not applying to the default route; the per-provider default models; `usage_models` as a separate monthly table rather than a column in `usage_daily`; a registered row still never `mode: "ai"`; the app pull requests waiting for `rc.2` rather than keeping two manifest shapes.

Ben's: whether to publish `rc.2` before Monday so the two app pull requests merge; whether the shipped default model per provider is the one he wants (OpenRouter `anthropic/claude-haiku-5.5`, Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct`, OpenAI `gpt-6-luna`); whether AI Gateway should be on by default on everyapp.team; whether `everyapp_ai_default` should be owners only.
