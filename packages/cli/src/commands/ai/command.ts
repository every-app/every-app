import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const showCommand = buildCommand({
  loader: async () => (await import(".")).show,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "What the workspace's default model resolves to now, and every provider it could be",
    fullDescription: [
      "The provider and model an app that asks for the default chat model gets (ai: { chat: true }",
      "in its manifest): the setting (ai default) if there is one, else the first provider of the",
      "shipped order whose key is set (OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral,",
      "Gemini), else what to set. Then every provider the default could be, in order, each with its",
      "key set or not and its catalog models. Reads the Gateway's setting names, never values.",
      "Says whether calls go through Cloudflare AI Gateway (ai gateway on).",
      "",
      "Example:",
      `  ${CLI} ai show`,
    ].join("\n"),
  },
});

const defaultCommand = buildCommand({
  loader: async () => (await import(".")).setDefault,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "provider[/model]|off",
          brief: "The provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-sonnet-5.5), or off",
          parse: String,
        },
      ],
    },
    flags: connectFlags,
  },
  docs: {
    brief: "Choose the default model (provider and model) for every app that asks for one, or off for the shipped order",
    fullDescription: [
      "The workspace's one AI setting, the same as Manage workspace → Usage → AI default. The",
      "provider id is everything up to the first slash, the model everything after it (a model id",
      "may hold slashes); without a model, the provider's catalog model serves. Embeddings always",
      "use the provider's catalog model. A provider whose key isn't set is accepted with a warning",
      "naming the key; one the default can't be (an API provider, an entry without an OpenAI-shaped",
      "chat route, AI Gateway) is refused (AI_DEFAULT_INVALID). The Gateway reads the change within",
      "30 seconds; a change queues ai.default_changed. Refused on a Gateway from before the setting",
      "(GATEWAY_PREDATES_AI_DEFAULT): run update first.",
      "",
      "Examples:",
      `  ${CLI} ai default openrouter`,
      `  ${CLI} ai default openrouter/anthropic/claude-sonnet-5.5`,
      `  ${CLI} ai default workers-ai --json`,
      `  ${CLI} ai default off`,
    ].join("\n"),
  },
});

const gatewayOnCommand = buildCommand({
  loader: async () => (await import(".")).gatewayOn,
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      id: {
        kind: "parsed",
        parse: String,
        brief: "The AI Gateway's id (its name in the dashboard): lowercase letters, digits and single hyphens; everyapp by default",
        optional: true,
        placeholder: "id",
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Put Cloudflare AI Gateway in front of every model call: find or make the gateway, set AI_GATEWAY_ID",
    fullDescription: [
      "Finds the AI Gateway in the Gateway's Cloudflare account (or makes it, logs on, no cache)",
      "and records its id as the Gateway setting AI_GATEWAY_ID. From the Gateway's next request",
      "every call to a model provider that AI Gateway fronts (OpenRouter, OpenAI, Anthropic, Groq,",
      "Mistral, Workers AI) goes through it with the provider's own key still on the call; Gemini",
      "and Cohere go direct. Changes no app and no key. For an authenticated gateway, set its",
      `token afterwards: ${CLI} secret set AI_GATEWAY_API_KEY.`,
      "",
      "Examples:",
      `  ${CLI} ai gateway on`,
      `  ${CLI} ai gateway on --id acme-models`,
    ].join("\n"),
  },
});

const gatewayOffCommand = buildCommand({
  loader: async () => (await import(".")).gatewayOff,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "Send model calls direct again: unset AI_GATEWAY_ID (the Cloudflare resource stays)",
    fullDescription: [
      "Unsets AI_GATEWAY_ID on the Gateway; every model call goes direct from its next request.",
      `The AI Gateway and its logs stay in the account. AI_GATEWAY_API_KEY stays until ${CLI} secret unset.`,
      "",
      "Example:",
      `  ${CLI} ai gateway off`,
    ].join("\n"),
  },
});

const gatewayRoutes = buildRouteMap({
  routes: { on: gatewayOnCommand, off: gatewayOffCommand },
  docs: { brief: "Cloudflare AI Gateway in front of every model call: on or off" },
});

/**
 * `everyapp ai show|default|gateway`: the workspace's default model, and
 * Cloudflare AI Gateway in front of the providers
 * (docs/design/2026-10-model-providers.md).
 */
export const aiRoutes = buildRouteMap({
  routes: {
    show: showCommand,
    default: defaultCommand,
    gateway: gatewayRoutes,
  },
  docs: {
    brief: "The default model apps get when they ask for one, and AI Gateway in front",
  },
});
