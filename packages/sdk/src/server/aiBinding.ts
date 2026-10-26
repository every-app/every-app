/**
 * `gatewayAiBinding(env)`: the Gateway's AI providers as a Workers AI
 * binding, for code written against `env.AI.run(model, inputs, options)`.
 *
 * An app on Every App needs no `ai` binding of its own to call models: the
 * Gateway holds the keys, counts the calls and keeps the app to `ai.models`.
 * Code that already calls `env.AI.run()` (upstream code a port keeps, the
 * Agents SDK, `workers-ai-provider`) gets this object in its place:
 *
 *   const AI = gatewayAiBinding(env, { for: request });
 *   await AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages });
 *
 * Each `run()` becomes an OpenAI-compatible call on the provider's route
 * through the Gateway (`createGatewayFetch`): text generation (`messages`
 * or `prompt`) on its chat completions route, text embeddings (`text`) on
 * its embeddings route, answered in Workers AI's shapes (`{ response,
 * tool_calls, usage }`, `{ shape, data }`, or a stream of `data:
 * {"response": …}` events with `stream: true`). In local development
 * without a Gateway, the developer's own key in `.dev.vars` is used, as
 * `createGatewayFetch` does (WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
 * for Workers AI).
 */
import {
  AI_DEFAULT_MODEL,
  AI_DEFAULT_PROVIDER,
  AI_DEFAULT_ROUTES,
  ConfigurationError,
  devAiProvider,
  type AiProviderId,
} from "../internal/index.js";
import type { GatewayCallFor } from "./attribution.js";
import { BINDING_ORIGIN, createGatewayFetch } from "./gatewayFetch.js";
import { GatewayRefusalError, gatewayRefusal } from "./refusal.js";

export interface GatewayAiBindingOptions {
  /**
   * Whom the calls are for: the inbound request, or `{ background: true,
   * organizationId }` (createGatewayFetch's `for`).
   */
  for?: GatewayCallFor;
  /**
   * The Gateway provider the calls go to: an `ai` entry of the catalog
   * with OpenAI-compatible routes (`workers-ai`, `openrouter`, `openai`,
   * …), or `default`, the operator's model (`ai: { chat: true }`).
   * Default: `workers-ai`, the provider `env.AI` reaches, so `@cf/…` model
   * ids work as they are. The manifest lists the provider under
   * `providers` (or says `ai.chat` for `default`).
   */
  provider?: AiProviderId | typeof AI_DEFAULT_PROVIDER;
  /**
   * The model id to send for a model the code names, e.g.
   * `{ "@cf/meta/llama-3.1-8b-instruct-fast": "meta-llama/llama-3.1-8b-instruct" }`
   * with `provider: "openrouter"`. A model not listed is sent as it is,
   * except that on `default` an `@cf/…` id becomes `default` (the
   * operator's model).
   */
  models?: Readonly<Record<string, string>>;
}

type Inputs = Record<string, unknown>;

interface RunOptions {
  returnRawResponse?: boolean;
  websocket?: boolean;
  signal?: AbortSignal;
}

/**
 * A Workers AI binding (`Ai`) over the Gateway: pass it where code takes
 * `env.AI`. `run()` covers text generation (messages or prompt; tools;
 * `stream: true`; `returnRawResponse`, which returns the provider's
 * OpenAI-shaped `Response`) and text embeddings; the binding's other
 * methods (`gateway()`, `autorag()`, `models()`, `toMarkdown()`, …) and
 * other tasks (images, audio, batches, websockets) throw
 * `ConfigurationError`. `options.gateway` is ignored: the Gateway's
 * operator decides whether calls go through Cloudflare AI Gateway
 * (`everyapp ai gateway on`).
 *
 * Errors are thrown as a binding throws them: `GatewayRefusalError` when
 * the Gateway refused (`ai_provider_not_configured`, `model_not_allowed`,
 * …), `ConfigurationError` where createGatewayFetch throws one (no binding
 * and no dev key), and an `Error` naming the status when the provider
 * answered with an error. Nothing is checked when the binding is made, so
 * making one per request costs nothing.
 */
export function gatewayAiBinding(
  env: object,
  options: GatewayAiBindingOptions = {},
): Ai {
  const provider = options.provider ?? "workers-ai";

  async function run(
    model: string,
    inputs: Inputs,
    runOptions: RunOptions = {},
  ): Promise<unknown> {
    if (runOptions.websocket) {
      throw unsupported("run() with websocket: true");
    }
    if (!inputs || typeof inputs !== "object") {
      throw unsupported("run() without an inputs object");
    }
    if (Array.isArray(inputs["requests"])) {
      throw unsupported("run() with a batch of requests");
    }
    const embedding =
      !("messages" in inputs) && !("prompt" in inputs) && "text" in inputs;
    if (!embedding && !("messages" in inputs) && !("prompt" in inputs)) {
      throw unsupported(
        "run() for anything but text generation (messages or prompt) and text embeddings (text)",
      );
    }
    const url = `${BINDING_ORIGIN}/api/ai/${provider}${routeOf(
      provider,
      embedding ? "embeddings" : "chat",
    )}`;
    const sent = modelToSend(provider, model, options.models);
    const body = embedding
      ? { model: sent, input: inputs["text"] }
      : chatBody(sent, inputs);
    const gatewayFetch = createGatewayFetch({
      env,
      for: options.for,
    });
    const response = await gatewayFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    });
    if (runOptions.returnRawResponse) return response;
    await throwIfFailed(response, provider);
    if (embedding) return embeddingOutput(await response.json());
    if (inputs["stream"] === true) {
      if (!response.body) return new ReadableStream();
      return response.body.pipeThrough(toWorkersAiStream());
    }
    return textOutput(await response.json());
  }

  const notHere = (method: string) => () => {
    throw unsupported(`env.AI.${method}()`);
  };
  const binding = {
    aiGatewayLogId: null,
    run,
    gateway: notHere("gateway"),
    autorag: notHere("autorag"),
    aiSearch: notHere("aiSearch"),
    websearch: notHere("websearch"),
    models: notHere("models"),
    toMarkdown: notHere("toMarkdown"),
  };
  // `Ai` is the app's own Workers types' class (it changes with each
  // version); the object above is its working subset, the rest throwing.
  return binding as unknown as Ai;
}

function unsupported(what: string): ConfigurationError {
  return new ConfigurationError(
    `${what} isn't available through the Every App gateway; call the provider's routes with createGatewayFetch() instead.`,
  );
}

/** The provider's path for a chat or an embeddings call, under `/api/ai/<provider>`. */
function routeOf(provider: string, kind: "chat" | "embeddings"): string {
  if (provider === AI_DEFAULT_PROVIDER) return AI_DEFAULT_ROUTES[kind];
  const spec = devAiProvider(provider);
  if (!spec) {
    throw new ConfigurationError(
      `gatewayAiBinding: ${JSON.stringify(provider)} is not an AI provider of the catalog.`,
    );
  }
  const route = spec[kind];
  if (!route) {
    throw new ConfigurationError(
      `gatewayAiBinding: ${provider} has no OpenAI-compatible ${kind === "chat" ? "chat completions" : "embeddings"} route.`,
    );
  }
  return route.path;
}

function modelToSend(
  provider: string,
  model: string,
  models: Readonly<Record<string, string>> | undefined,
): string {
  const mapped = models && Object.hasOwn(models, model) ? models[model] : null;
  if (mapped) return mapped;
  if (provider === AI_DEFAULT_PROVIDER && model.startsWith("@cf/")) {
    return AI_DEFAULT_MODEL;
  }
  return model;
}

/**
 * Workers AI's text generation inputs as a chat completions body: `prompt`
 * as one user message, legacy tools (`{ name, description, parameters }`)
 * as OpenAI's, everything else (max_tokens, temperature, response_format,
 * stream, …) as it is. Never adds `stream_options` (Workers AI refuses it
 * on a call that doesn't stream).
 */
function chatBody(model: string, inputs: Inputs): Record<string, unknown> {
  const { prompt, messages, tools, raw: _raw, lora: _lora, ...rest } = inputs;
  const body: Record<string, unknown> = {
    ...rest,
    model,
    messages:
      messages ??
      (typeof prompt === "string" ? [{ role: "user", content: prompt }] : []),
  };
  if (Array.isArray(tools)) body["tools"] = tools.map(openAiTool);
  return body;
}

function openAiTool(tool: unknown): unknown {
  if (!isRecord(tool) || "function" in tool) return tool;
  const { name, description, parameters } = tool;
  return {
    type: "function",
    function: {
      name,
      ...(description === undefined ? {} : { description }),
      ...(parameters === undefined ? {} : { parameters }),
    },
  };
}

async function throwIfFailed(
  response: Response,
  provider: string,
): Promise<void> {
  if (response.ok) return;
  const refusal = await gatewayRefusal(response.clone());
  if (refusal) throw new GatewayRefusalError(refusal);
  const text = await response.text().catch(() => "");
  throw new Error(
    `AI (${provider}) answered ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
  );
}

/** A chat completion as Workers AI answers text generation. */
function textOutput(body: unknown): Record<string, unknown> {
  const choice = firstChoice(body);
  const message = isRecord(choice?.["message"]) ? choice["message"] : {};
  const toolCalls = workersAiToolCalls(message["tool_calls"]);
  const usage = isRecord(body) ? body["usage"] : undefined;
  return {
    // Workers AI may send an all-digit reply as a JSON number.
    response: textOf(message["content"]),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(isRecord(usage) ? { usage } : {}),
  };
}

/**
 * OpenAI tool calls as both forms Workers AI answers with: the legacy
 * `{ name, arguments }` (arguments parsed) and the OpenAI-shaped
 * `{ id, type, function }`.
 */
function workersAiToolCalls(calls: unknown): unknown[] | undefined {
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  return calls.filter(isRecord).map((call) => {
    const fn = isRecord(call["function"]) ? call["function"] : {};
    const args = fn["arguments"];
    return {
      ...(call["id"] === undefined ? {} : { id: call["id"] }),
      type: "function",
      function: { name: fn["name"], arguments: args },
      name: fn["name"],
      arguments: typeof args === "string" ? parsedOr(args) : args,
    };
  });
}

/** Embeddings as Workers AI answers them: `{ shape: [rows, dimensions], data }`. */
function embeddingOutput(body: unknown): { shape: number[]; data: number[][] } {
  const rows =
    isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
  const data = rows
    .filter(isRecord)
    .sort((a, b) => Number(a["index"] ?? 0) - Number(b["index"] ?? 0))
    .map((row) =>
      Array.isArray(row["embedding"]) ? (row["embedding"] as number[]) : [],
    );
  return { shape: [data.length, data[0]?.length ?? 0], data };
}

/**
 * An OpenAI chat completions event stream as Workers AI streams text:
 * one `data: {"response": "<token>"}` event per chunk with text (tool call
 * deltas and usage alongside), then `data: [DONE]`.
 */
function toWorkersAiStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const convert = (line: string): string => {
    const match = /^data:[ ]?(.*?)\r?$/s.exec(line);
    if (!match) return "";
    const data = match[1]!.trim();
    if (data === "[DONE]") return "data: [DONE]\n\n";
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return "";
    }
    const choice = firstChoice(chunk);
    const delta = isRecord(choice?.["delta"]) ? choice["delta"] : {};
    const usage = isRecord(chunk) ? chunk["usage"] : undefined;
    const toolCalls = Array.isArray(delta["tool_calls"])
      ? delta["tool_calls"]
      : undefined;
    const event = {
      response: textOf(delta["content"]),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(isRecord(usage) ? { usage } : {}),
    };
    if (!event.response && !toolCalls && !isRecord(usage)) return "";
    return `data: ${JSON.stringify(event)}\n\n`;
  };
  return new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      const end = pending.lastIndexOf("\n");
      if (end === -1) return;
      const lines = pending.slice(0, end).split("\n");
      pending = pending.slice(end + 1);
      const out = lines.map(convert).join("");
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      pending += decoder.decode();
      const out = convert(pending);
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

function firstChoice(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body["choices"])) return undefined;
  const choice: unknown = body["choices"][0];
  return isRecord(choice) ? choice : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "number") return String(content);
  return "";
}

function parsedOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
