/**
 * The upstream request each catalog AI provider gets, byte for byte, pinned
 * as literals captured on main at 7b73d9f6 (2026-10-25) before the `ai`
 * entries' per-route rules became fields and the AI Gateway fronting and
 * the `default` route were added (docs/design/2026-10-model-providers.md).
 * Anthropic, Gemini, Mistral, Groq and Cohere here; OpenAI, OpenRouter and
 * Workers AI are in provider-migration.test.ts. A change to any URL,
 * method, header, body or answer is a behaviour change for a deployed
 * app, so the expected values are written out, never derived from the
 * code. To see what the code produces now: PRINT_PROVIDER_BYTES=1.
 */
import { describe, expect, it, vi } from "vitest";
import { handleAuthenticatedAiProxyRequest } from "./ai-proxy";

const ORIGIN = "http://every-app-gateway.internal";

interface Seen {
  url: string;
  method: string;
  redirect: string;
  headers: [string, string][];
  body: string;
  answer: { status: number; headers: [string, string][]; body: string };
}

async function seen(upstream: Request, answered: Response): Promise<Seen> {
  return {
    url: upstream.url,
    method: upstream.method,
    redirect: upstream.redirect,
    headers: [...upstream.headers.entries()].sort(),
    body: await upstream.text(),
    answer: {
      status: answered.status,
      headers: [...answered.headers.entries()]
        .filter(([name]) => name !== "content-length")
        .sort(),
      body: await answered.text(),
    },
  };
}

const APP_HEADERS = {
  authorization: "Bearer app-supplied",
  "x-api-key": "app-supplied",
  cookie: "session=1",
  "x-everyapp-identity": "not-a-token",
  "x-user-email": "someone@example.com",
  "content-type": "application/json",
  "x-request-id": "req-1",
  "anthropic-version": "2023-06-01",
};

async function aiCall(
  provider: string,
  path: string,
  env: Record<string, string>,
  body: string,
): Promise<Seen> {
  let captured: Request | undefined;
  const response = await handleAuthenticatedAiProxyRequest({
    request: new Request(`${ORIGIN}/api/ai/${provider}${path}?stream=false`, {
      method: "POST",
      headers: APP_HEADERS,
      body,
    }),
    provider,
    env,
    caller: { organizationId: "org-1", appId: "app" },
    fetchUpstream: async (request) => {
      captured = request;
      return Response.json(
        {
          id: "cmpl-1",
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        { headers: { "x-request-id": "up-1" } },
      );
    },
  });
  return seen(captured!, response);
}

/** A call the proxy refuses: no upstream request, the refusal as the answer. */
async function refusedCall(
  provider: string,
  path: string,
  env: Record<string, string>,
): Promise<Seen> {
  let captured: Request | undefined;
  const response = await handleAuthenticatedAiProxyRequest({
    request: new Request(`${ORIGIN}/api/ai/${provider}${path}`, {
      method: "POST",
      headers: APP_HEADERS,
      body: "{}",
    }),
    provider,
    env,
    caller: { organizationId: "org-1", appId: "app" },
    fetchUpstream: async (request) => {
      captured = request;
      return new Response("unreachable");
    },
  });
  if (captured) throw new Error("the proxy sent a refused call upstream");
  return seen(new Request("https://none.invalid/"), response);
}

const CASES: Record<string, () => Promise<Seen>> = {
  anthropic: () =>
    aiCall(
      "anthropic",
      "/v1/messages",
      { ANTHROPIC_API_KEY: " sk-ant " },
      '{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}',
    ),
  gemini: () =>
    aiCall(
      "gemini",
      "/v1beta/openai/chat/completions",
      { GEMINI_API_KEY: "AIza" },
      '{"model":"gemini-3-flash","messages":[{"role":"user","content":"hi"}],"store":true}',
    ),
  mistral: () =>
    aiCall(
      "mistral",
      "/v1/chat/completions",
      { MISTRAL_API_KEY: "mis" },
      '{"model":"mistral-small-latest","messages":[{"role":"user","content":"hi"}]}',
    ),
  groq: () =>
    aiCall(
      "groq",
      "/openai/v1/chat/completions",
      { GROQ_API_KEY: "gsk" },
      '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}',
    ),
  cohere: () =>
    aiCall(
      "cohere",
      "/v2/chat",
      { COHERE_API_KEY: "co" },
      '{"model":"command-a","messages":[{"role":"user","content":"hi"}]}',
    ),
  // Not inference: refused before any request goes upstream.
  "mistral (account-level path refused)": () =>
    refusedCall("mistral", "/v1/files", { MISTRAL_API_KEY: "mis" }),
};

const EXPECTED: Record<string, Seen> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["anthropic-version", "2023-06-01"],
      ["authorization", "Bearer sk-ant"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["anthropic-version", "2023-06-01"],
      ["authorization", "Bearer AIza"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"gemini-3-flash","messages":[{"role":"user","content":"hi"}],"store":true}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["anthropic-version", "2023-06-01"],
      ["authorization", "Bearer mis"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"mistral-small-latest","messages":[{"role":"user","content":"hi"}]}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["anthropic-version", "2023-06-01"],
      ["authorization", "Bearer gsk"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  cohere: {
    url: "https://api.cohere.com/v2/chat?stream=false",
    method: "POST",
    redirect: "follow",
    headers: [
      ["anthropic-version", "2023-06-01"],
      ["authorization", "Bearer co"],
      ["content-type", "application/json"],
      ["x-request-id", "req-1"],
    ],
    body: '{"model":"command-a","messages":[{"role":"user","content":"hi"}]}',
    answer: {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", "up-1"],
      ],
      body: '{"id":"cmpl-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    },
  },
  "mistral (account-level path refused)": {
    url: "https://none.invalid/",
    method: "GET",
    redirect: "follow",
    headers: [],
    body: "",
    answer: {
      status: 403,
      headers: [
        ["content-type", "application/json"],
        ["x-everyapp-error", "ai_route_not_allowed"],
      ],
      body: '{"error":{"message":"This provider endpoint is not available to apps","code":"ai_route_not_allowed","type":"gateway_refusal"},"code":"ai_route_not_allowed","message":"This provider endpoint is not available to apps"}',
    },
  },
};

describe("the catalog AI providers broker byte for byte as before the model-providers refactor", () => {
  const printing = Boolean(process.env["PRINT_PROVIDER_BYTES"]);

  it.each(Object.keys(CASES))("%s", async (name) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const actual = await CASES[name]!();
    vi.restoreAllMocks();
    if (printing) {
      process.stdout.write(
        `\n=== ${name}\n${JSON.stringify(actual, null, 2)}\n`,
      );
      return;
    }
    expect(actual).toEqual(EXPECTED[name]);
  });
});
