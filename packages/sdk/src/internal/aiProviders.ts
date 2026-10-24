/**
 * The gateway's AI providers as the SDK's local-dev fallback reaches them:
 * with no gateway binding, a developer's own key, under the name of the
 * gateway secret that holds it, goes to the provider directly. Deployed
 * apps always go through the gateway, which holds the real keys.
 */
export interface DevAiProviderSpec {
  origin: string;
  /** The gateway secret holding the provider key; in local dev, the `.dev.vars` name. */
  keyEnv: string;
  /** Where an operator gets the key: the provider's API keys page. */
  docs: string;
  /** The everyapp skill's setup guide for it, relative to the skill (`setup/openai.md`). */
  setup: string;
  /** Gateway settings the provider's URL needs besides the key, under the same names. */
  alsoNeeds?: readonly string[];
  /** The path every provider path is joined onto, from those settings. */
  basePath?: (settings: Readonly<Record<string, string>>) => string;
  /** Turns the provider's response at `path` into what OpenAI clients parse. */
  normalizeResponse?: (path: string, response: Response) => Response;
}

export type DevAiProvider = "openai" | "openrouter" | "workers-ai";

export const DEV_AI_PROVIDERS: Readonly<
  Record<DevAiProvider, DevAiProviderSpec>
> = {
  openai: {
    origin: "https://api.openai.com",
    keyEnv: "OPENAI_API_KEY",
    docs: "https://platform.openai.com/api-keys",
    setup: "setup/openai.md",
  },
  openrouter: {
    origin: "https://openrouter.ai",
    keyEnv: "OPENROUTER_API_KEY",
    docs: "https://openrouter.ai/settings/keys",
    setup: "setup/openrouter.md",
  },
  // Workers AI's OpenAI-compatible endpoints, under the account's path.
  "workers-ai": {
    origin: "https://api.cloudflare.com",
    keyEnv: "WORKERS_AI_API_TOKEN",
    // A token from the "Workers AI" template (Read and Edit).
    docs: "https://dash.cloudflare.com/profile/api-tokens",
    setup: "setup/workers-ai.md",
    alsoNeeds: ["CLOUDFLARE_ACCOUNT_ID"],
    basePath: (settings) =>
      workersAiBasePath(settings["CLOUDFLARE_ACCOUNT_ID"] ?? ""),
    normalizeResponse: normalizeWorkersAiResponse,
  },
};

export function devAiProvider(name: string): DevAiProviderSpec | undefined {
  return Object.hasOwn(DEV_AI_PROVIDERS, name)
    ? DEV_AI_PROVIDERS[name as DevAiProvider]
    : undefined;
}

/** Every setting a provider needs, its key first: the names `.dev.vars` and the gateway use. */
export function aiProviderSettings(spec: DevAiProviderSpec): string[] {
  return [spec.keyEnv, ...(spec.alsoNeeds ?? [])];
}

/** The account-scoped base path of Workers AI's REST API. */
export function workersAiBasePath(accountId: string): string {
  return `/client/v4/accounts/${encodeURIComponent(accountId.trim())}/ai`;
}

/**
 * `base` with `path` joined onto its path (never replacing it) and
 * `search` as its query: `https://api.cloudflare.com/client/v4/accounts/<id>/ai`
 * and `/v1/chat/completions` make `…/ai/v1/chat/completions`. `path` starts
 * with one slash; null when the result would leave `base`'s path.
 */
export function joinProviderUrl(
  base: string,
  path: string,
  search = "",
): URL | null {
  const url = new URL(base);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${path}`;
  url.search = search;
  url.hash = "";
  return url.pathname === `${basePath}${path}` ? url : null;
}

const WORKERS_AI_NORMALIZED_ROUTES: ReadonlySet<string> = new Set([
  "/v1/chat/completions",
]);

/** Text fields of a chat completion choice that OpenAI clients require as strings. */
const TEXT_FIELDS = ["content", "reasoning_content", "reasoning"] as const;
const NUMERIC_TEXT_FIELD =
  /"(?:content|reasoning_content|reasoning)"\s*:\s*-?\d/;

/**
 * Workers AI's OpenAI-compatible chat completions on the vLLM-backed models
 * (Meta's Llama among them) send a token made only of digits as a JSON
 * number (`"delta":{"content":18}`), which OpenAI clients refuse:
 * `@ai-sdk/openai-compatible` drops the token and reports an error part.
 * This turns such numbers back into strings, in `choices[].delta` (streams)
 * and `choices[].message` (whole JSON bodies); every other event or body
 * passes through byte for byte. Remove it once Cloudflare sends strings.
 */
export function normalizeWorkersAiResponse(
  path: string,
  response: Response,
): Response {
  if (!response.body || !WORKERS_AI_NORMALIZED_ROUTES.has(path)) {
    return response;
  }
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  const transform = contentType.startsWith("text/event-stream")
    ? normalizeSseLines()
    : contentType.startsWith("application/json")
      ? normalizeJsonBody()
      : null;
  if (!transform) return response;
  const headers = new Headers(response.headers);
  // The body may change length.
  headers.delete("content-length");
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Stringify numeric text fields of every choice in a chat completion (chunk). */
function stringifyNumericText(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload["choices"])) return false;
  let changed = false;
  for (const choice of payload["choices"]) {
    if (!isRecord(choice)) continue;
    for (const part of [choice["delta"], choice["message"]]) {
      if (!isRecord(part)) continue;
      for (const field of TEXT_FIELDS) {
        const value = part[field];
        if (typeof value === "number") {
          part[field] = String(value);
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** `json` with its numeric text fields as strings, or null when it has none. */
function normalizedJson(json: string): string | null {
  if (!NUMERIC_TEXT_FIELD.test(json)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  return stringifyNumericText(payload) ? JSON.stringify(payload) : null;
}

/**
 * An SSE stream, line by line: a `data:` line whose JSON has a numeric text
 * field is rewritten, every other line (and its line ending) is kept.
 */
function normalizeSseLines(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const normalizeLine = (line: string): string => {
    const match = /^(data:[ ]?)(.*?)(\r?)$/s.exec(line);
    if (!match) return line;
    const rewritten = normalizedJson(match[2]!);
    return rewritten === null ? line : `${match[1]}${rewritten}${match[3]}`;
  };
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const end = pending.lastIndexOf("\n");
      if (end === -1) return;
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      controller.enqueue(
        encoder.encode(complete.split("\n").map(normalizeLine).join("\n")),
      );
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(normalizeLine(pending)));
    },
  });
}

/** A whole JSON body: rewritten when it has a numeric text field, else kept as sent. */
function normalizeJsonBody(): TransformStream<Uint8Array, Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new TransformStream({
    transform(chunk) {
      chunks.push(chunk);
    },
    flush(controller) {
      const decoder = new TextDecoder();
      const text =
        chunks
          .map((chunk) => decoder.decode(chunk, { stream: true }))
          .join("") + decoder.decode();
      const rewritten = normalizedJson(text);
      if (rewritten !== null) {
        controller.enqueue(new TextEncoder().encode(rewritten));
        return;
      }
      for (const chunk of chunks) controller.enqueue(chunk);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
