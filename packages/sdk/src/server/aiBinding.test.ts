import { afterEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import { ConfigurationError } from "../internal/index";
import { gatewayAiBinding, type GatewayAiBindingOptions } from "./aiBinding";
import { GatewayRefusalError } from "./refusal";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The binding with `run()` untyped: the SDK's Workers types name only the
 * models of their version, and these tests check behaviour, not typing.
 */
function binding(env: object, options?: GatewayAiBindingOptions) {
  return gatewayAiBinding(env, options) as unknown as Omit<Ai, "run"> & {
    run(
      model: string,
      inputs: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<any>;
  };
}

function gateway(response: () => Response) {
  const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => response(),
  );
  return { env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } }, bindingFetch };
}

function completion(message: Record<string, unknown>, usage?: unknown) {
  return Response.json({
    choices: [{ index: 0, message }],
    ...(usage ? { usage } : {}),
  });
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return (await request.json()) as Record<string, unknown>;
}

const SCANNER = "@cf/meta/llama-3.1-8b-instruct-fast";

describe("gatewayAiBinding", () => {
  it("is an Ai: assignable where env.AI is expected, with no cast", () => {
    const { env } = gateway(() => completion({ content: "" }));
    const AI: Ai = gatewayAiBinding(env);
    const withAi: { AI: Ai } = { AI: gatewayAiBinding({}) };
    expect(typeof AI.run).toBe("function");
    expect(typeof withAi.AI.run).toBe("function");
  });

  it("runs messages as a Workers AI chat completion through the gateway, for the request", async () => {
    const { env, bindingFetch } = gateway(() =>
      completion(
        { role: "assistant", content: "NO" },
        { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
      ),
    );
    const AI = binding(env, {
      for: new Request("https://inbox.example.com/api/x", {
        headers: { "x-everyapp-identity": "signed-user-identity" },
      }),
    });

    const answer = await AI.run(SCANNER, {
      messages: [
        { role: "system", content: "Answer YES or NO." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    expect(answer).toEqual({
      response: "NO",
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    });
    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/ai/workers-ai/v1/chat/completions",
    );
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    await expect(sent.json()).resolves.toEqual({
      model: SCANNER,
      messages: [
        { role: "system", content: "Answer YES or NO." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 10,
      temperature: 0,
    });
  });

  it("sends a prompt as one user message and returns an all-digit reply as text", async () => {
    const { env, bindingFetch } = gateway(() => completion({ content: 42 }));
    const answer = await binding(env).run(SCANNER, {
      prompt: "Six times seven?",
    });
    expect(answer).toEqual({ response: "42" });
    const body = await bodyOf(bindingFetch.mock.calls[0]![0]);
    expect(body).toEqual({
      model: SCANNER,
      messages: [{ role: "user", content: "Six times seven?" }],
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  it("sends legacy tools as OpenAI's and answers tool calls in both Workers AI forms", async () => {
    const { env, bindingFetch } = gateway(() =>
      completion({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "draft_reply", arguments: '{"body":"Hi"}' },
          },
        ],
      }),
    );
    const parameters = {
      type: "object",
      properties: { body: { type: "string" } },
    };
    const answer = await binding(env).run(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      {
        messages: [{ role: "user", content: "Draft a reply" }],
        tools: [
          { name: "draft_reply", description: "Drafts a reply", parameters },
          {
            type: "function",
            function: { name: "search", parameters },
          },
        ],
      },
    );

    expect(answer).toEqual({
      response: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "draft_reply", arguments: '{"body":"Hi"}' },
          name: "draft_reply",
          arguments: { body: "Hi" },
        },
      ],
    });
    const body = await bodyOf(bindingFetch.mock.calls[0]![0]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "draft_reply",
          description: "Drafts a reply",
          parameters,
        },
      },
      { type: "function", function: { name: "search", parameters } },
    ]);
  });

  it("runs text embeddings on the embeddings route as { shape, data }", async () => {
    const { env, bindingFetch } = gateway(() =>
      Response.json({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    );
    const answer = await binding(env).run("@cf/baai/bge-m3", {
      text: ["first", "second"],
    });
    expect(answer).toEqual({
      shape: [2, 2],
      data: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });
    const sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/ai/workers-ai/v1/embeddings",
    );
    await expect(sent.json()).resolves.toEqual({
      model: "@cf/baai/bge-m3",
      input: ["first", "second"],
    });
  });

  it("streams as Workers AI does: data: {response} events, then [DONE]", async () => {
    const events = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"de',
      'lta":{"content":18}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { env, bindingFetch } = gateway(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const event of events) {
                controller.enqueue(new TextEncoder().encode(event));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const stream = await binding(env).run(SCANNER, {
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });

    expect(stream).toBeInstanceOf(ReadableStream);
    const text = await new Response(stream as ReadableStream).text();
    expect(text).toBe(
      'data: {"response":"Hel"}\n\ndata: {"response":"18"}\n\ndata: [DONE]\n\n',
    );
    const body = await bodyOf(bindingFetch.mock.calls[0]![0]);
    expect(body.stream).toBe(true);
  });

  it("returns the provider's response itself with returnRawResponse", async () => {
    const { env } = gateway(() => completion({ content: "raw" }));
    const response = await binding(env).run(
      SCANNER,
      { prompt: "Hi" },
      { returnRawResponse: true },
    );
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      choices: [{ message: { content: "raw" } }],
    });
  });

  it("throws the gateway's refusal, and the provider's error with its status", async () => {
    const refused = gateway(
      () =>
        new Response(
          JSON.stringify({
            message: "The gateway needs WORKERS_AI_API_TOKEN.",
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "x-everyapp-error": "ai_provider_not_configured",
            },
          },
        ),
    );
    const error = await binding(refused.env)
      .run(SCANNER, { prompt: "Hi" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayRefusalError);
    expect(error).toMatchObject({
      code: "ai_provider_not_configured",
      status: 503,
      message: "The gateway needs WORKERS_AI_API_TOKEN.",
    });

    const failed = gateway(() => new Response("bad input", { status: 400 }));
    await expect(
      binding(failed.env).run(SCANNER, { prompt: "Hi" }),
    ).rejects.toThrow("AI (workers-ai) answered 400: bad input");
  });

  it("takes the operator's default model for @cf ids on provider default, and maps ids for another provider", async () => {
    const { env, bindingFetch } = gateway(() => completion({ content: "ok" }));
    await binding(env, { provider: "default" }).run(SCANNER, {
      prompt: "Hi",
    });
    let sent = bindingFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/ai/default/v1/chat/completions",
    );
    expect((await bodyOf(sent)).model).toBe("default");

    await binding(env, {
      provider: "openrouter",
      models: { [SCANNER]: "meta-llama/llama-3.1-8b-instruct" },
    }).run(SCANNER, { prompt: "Hi" });
    sent = bindingFetch.mock.calls[1]![0];
    expect(sent.url).toBe(
      "http://every-app-gateway.internal/api/ai/openrouter/api/v1/chat/completions",
    );
    expect((await bodyOf(sent)).model).toBe("meta-llama/llama-3.1-8b-instruct");
  });

  it("calls Workers AI with the developer's own token in local development", async () => {
    const directFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => completion({ content: "from dev" }),
    );
    vi.stubGlobal("fetch", directFetch);
    const AI = binding({
      EVERYAPP_DEV: "1",
      WORKERS_AI_API_TOKEN: "dev-token",
      CLOUDFLARE_ACCOUNT_ID: "acc123",
    });

    await expect(AI.run(SCANNER, { prompt: "Hi" })).resolves.toEqual({
      response: "from dev",
    });
    const sent = directFetch.mock.calls[0]![0];
    expect(sent.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions",
    );
    expect(sent.headers.get("authorization")).toBe("Bearer dev-token");
  });

  it("is made without checks; run() throws ConfigurationError with no gateway and no key", async () => {
    const AI = binding({});
    await expect(AI.run(SCANNER, { prompt: "Hi" })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("refuses what the gateway can't carry with ConfigurationError", async () => {
    const { env, bindingFetch } = gateway(() => completion({ content: "" }));
    const AI = binding(env);
    await expect(
      AI.run("@cf/black-forest-labs/flux-1-schnell", { image: [1, 2] }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      AI.run(SCANNER, { prompt: "Hi" }, { websocket: true }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(() => AI.gateway("my-gateway")).toThrow(ConfigurationError);
    expect(() => AI.autorag("rag")).toThrow(ConfigurationError);
    await expect(
      binding(env, { provider: "anthropic" }).run("@cf/baai/bge-m3", {
        text: "no embeddings there",
      }),
    ).rejects.toThrow("anthropic has no OpenAI-compatible embeddings route");
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});
