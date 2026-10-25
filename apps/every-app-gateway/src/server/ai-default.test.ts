/**
 * The default route (`/api/ai/default/…`) and Cloudflare AI Gateway in
 * front of the providers (docs/design/2026-10-model-providers.md): what
 * the proxy sends upstream for each, byte for byte, and every refusal.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveAiDefault } from "@every-app/sdk/internal";
import { handleAuthenticatedAiProxyRequest } from "./ai-proxy";

const ORIGIN = "http://every-app-gateway.internal";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
  status: number;
  code: string | null;
  answer: string;
}

const isSetIn = (env: Record<string, string>) => (name: string) =>
  typeof env[name] === "string" && env[name]!.trim().length > 0;

async function call(input: {
  provider: string;
  path: string;
  env: Record<string, string>;
  body?: string | FormData;
  choice?: string | null;
  defaultRoute?: boolean;
  headers?: Record<string, string>;
}): Promise<Seen> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let captured: Request | undefined;
  const body = input.body ?? '{"messages":[{"role":"user","content":"hi"}]}';
  const headers: Record<string, string> = {
    ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
    "x-request-id": "req-1",
    ...input.headers,
  };
  const aiDefault =
    input.provider === "default"
      ? resolveAiDefault({
          choice: input.choice
            ? {
                provider: input.choice.split("/")[0]!,
                ...(input.choice.includes("/")
                  ? { model: input.choice.slice(input.choice.indexOf("/") + 1) }
                  : {}),
              }
            : null,
          isSet: isSetIn(input.env),
        })
      : undefined;
  const response = await handleAuthenticatedAiProxyRequest({
    request: new Request(`${ORIGIN}/api/ai/${input.provider}${input.path}`, {
      method: "POST",
      headers,
      body,
    }),
    provider: input.provider,
    env: input.env,
    ...(aiDefault ? { aiDefault } : {}),
    caller: { organizationId: "org-1", appId: "app" },
    fetchUpstream: async (request) => {
      captured = request;
      return Response.json({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  vi.restoreAllMocks();
  return {
    url: captured?.url ?? "",
    headers: captured ? Object.fromEntries(captured.headers.entries()) : {},
    body: captured ? await captured.text() : "",
    status: response.status,
    code: response.headers.get("x-everyapp-error"),
    answer: await response.text(),
  };
}

const OPENROUTER = { OPENROUTER_API_KEY: "sk-or" };
const AIG = { CLOUDFLARE_ACCOUNT_ID: "acc 1", AI_GATEWAY_ID: "everyapp" };

describe("the default route", () => {
  it("goes to OpenRouter's chat route with its model filled in when nothing is chosen and only OpenRouter is set", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: OPENROUTER,
    });
    expect(seen.status).toBe(200);
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen.headers["authorization"]).toBe("Bearer sk-or");
    expect(JSON.parse(seen.body)).toEqual({
      messages: [{ role: "user", content: "hi" }],
      model: "anthropic/claude-haiku-5.5",
    });
  });

  it("fills the model in for `default` and keeps a model the app named", async () => {
    const named = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: OPENROUTER,
      body: '{"model":"default","messages":[]}',
    });
    expect(JSON.parse(named.body).model).toBe("anthropic/claude-haiku-5.5");
    const pinned = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: OPENROUTER,
      body: '{"model":"openai/gpt-6-sol","messages":[]}',
    });
    expect(JSON.parse(pinned.body).model).toBe("openai/gpt-6-sol");
  });

  it("takes the operator's choice, provider and model, over the order", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: { ...OPENROUTER, GROQ_API_KEY: "gsk" },
      choice: "groq/openai/gpt-oss-120b",
    });
    expect(seen.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seen.headers["authorization"]).toBe("Bearer gsk");
    expect(JSON.parse(seen.body).model).toBe("openai/gpt-oss-120b");
  });

  it("falls to Workers AI when no key is set but the Gateway's own token is", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: { WORKERS_AI_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acc" },
    });
    expect(seen.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions",
    );
    expect(JSON.parse(seen.body).model).toBe(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
    );
  });

  it("maps embeddings onto the provider's embeddings route with its model", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/embeddings",
      env: OPENROUTER,
      body: '{"input":"hi"}',
    });
    expect(seen.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(JSON.parse(seen.body)).toEqual({
      input: "hi",
      model: "openai/text-embedding-3-small",
    });
  });

  it("refuses with ai_default_not_configured, naming the key, when nothing is set", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: {},
    });
    expect(seen.status).toBe(503);
    expect(seen.code).toBe("ai_default_not_configured");
    expect(seen.answer).toContain("OPENROUTER_API_KEY");
    expect(seen.answer).toContain("everyapp ai default");
    expect(seen.url).toBe("");
  });

  it("refuses with ai_default_not_configured naming the chosen provider's key when the choice isn't set", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: OPENROUTER,
      choice: "openai",
    });
    expect(seen.status).toBe(503);
    expect(seen.code).toBe("ai_default_not_configured");
    expect(seen.answer).toContain("OPENAI_API_KEY");
    expect(seen.answer).toContain("OpenAI");
  });

  it("serves chat and embeddings only", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/responses",
      env: OPENROUTER,
    });
    expect(seen.status).toBe(403);
    expect(seen.code).toBe("ai_route_not_allowed");
    expect(seen.url).toBe("");
  });

  it("refuses when no resolution was passed", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await handleAuthenticatedAiProxyRequest({
      request: new Request(`${ORIGIN}/api/ai/default/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      }),
      provider: "default",
      env: OPENROUTER,
      fetchUpstream: async () => {
        throw new Error("unreachable");
      },
    });
    vi.restoreAllMocks();
    expect(response.status).toBe(503);
    expect(response.headers.get("x-everyapp-error")).toBe(
      "ai_default_not_configured",
    );
  });

  it("fills the model into a form body too", async () => {
    const form = new FormData();
    form.set("input", "hello");
    const seen = await call({
      provider: "default",
      path: "/v1/embeddings",
      env: OPENROUTER,
      body: form,
    });
    expect(seen.body).toContain('name="model"');
    expect(seen.body).toContain("openai/text-embedding-3-small");
  });
});

describe("AI Gateway in front of the providers", () => {
  it("is never called by id: the proxy entry serves no models", async () => {
    const seen = await call({
      provider: "ai-gateway",
      path: "/openrouter/v1/chat/completions",
      env: { ...OPENROUTER, ...AIG },
    });
    expect(seen.status).toBe(404);
    expect(seen.code).toBe("ai_provider_not_supported");
    expect(seen.answer).toContain("everyapp ai gateway on");
  });

  it("sends OpenRouter under the gateway's URL with `/api` dropped and the OpenRouter key kept", async () => {
    const seen = await call({
      provider: "openrouter",
      path: "/api/v1/chat/completions?x=1",
      env: { ...OPENROUTER, ...AIG },
      body: '{"model":"m","messages":[]}',
    });
    expect(seen.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc%201/everyapp/openrouter/v1/chat/completions?x=1",
    );
    expect(seen.headers["authorization"]).toBe("Bearer sk-or");
    expect(seen.headers["cf-aig-authorization"]).toBeUndefined();
  });

  it("drops OpenAI's `/v1` and Groq's `/openai/v1`", async () => {
    const openai = await call({
      provider: "openai",
      path: "/v1/chat/completions",
      env: { OPENAI_API_KEY: "sk", ...AIG },
      body: '{"model":"m","messages":[]}',
    });
    expect(openai.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc%201/everyapp/openai/chat/completions",
    );
    const groq = await call({
      provider: "groq",
      path: "/openai/v1/chat/completions",
      env: { GROQ_API_KEY: "gsk", ...AIG },
      body: '{"model":"m","messages":[]}',
    });
    expect(groq.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc%201/everyapp/groq/chat/completions",
    );
  });

  it("keeps Workers AI's own URL and names the gateway in a header", async () => {
    const seen = await call({
      provider: "workers-ai",
      path: "/v1/chat/completions",
      env: { WORKERS_AI_API_TOKEN: "cf", ...AIG },
      body: '{"model":"@cf/m","messages":[]}',
    });
    expect(seen.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc%201/ai/v1/chat/completions",
    );
    expect(seen.headers["cf-aig-gateway-id"]).toBe("everyapp");
    expect(seen.headers["authorization"]).toBe("Bearer cf");
  });

  it("adds the gateway token for an authenticated gateway, and the app can't set it", async () => {
    const seen = await call({
      provider: "openrouter",
      path: "/api/v1/chat/completions",
      env: { ...OPENROUTER, ...AIG, AI_GATEWAY_API_KEY: "aig-token" },
      body: '{"model":"m","messages":[]}',
      headers: {
        "cf-aig-authorization": "Bearer app-supplied",
        "cf-aig-cache-ttl": "60",
      },
    });
    expect(seen.headers["cf-aig-authorization"]).toBe("Bearer aig-token");
    expect(seen.headers["cf-aig-cache-ttl"]).toBeUndefined();
  });

  it("sends a provider with no documented AI Gateway form direct", async () => {
    const seen = await call({
      provider: "gemini",
      path: "/v1beta/openai/chat/completions",
      env: { GEMINI_API_KEY: "AIza", ...AIG },
      body: '{"model":"m","messages":[]}',
    });
    expect(seen.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(seen.headers["cf-aig-gateway-id"]).toBeUndefined();
  });

  it("goes direct when the gateway id is set without the account", async () => {
    const seen = await call({
      provider: "openrouter",
      path: "/api/v1/chat/completions",
      env: { ...OPENROUTER, AI_GATEWAY_ID: "everyapp" },
      body: '{"model":"m","messages":[]}',
    });
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("fronts the default route's provider too", async () => {
    const seen = await call({
      provider: "default",
      path: "/v1/chat/completions",
      env: { ...OPENROUTER, ...AIG },
    });
    expect(seen.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc%201/everyapp/openrouter/v1/chat/completions",
    );
    expect(JSON.parse(seen.body).model).toBe("anthropic/claude-haiku-5.5");
  });
});
