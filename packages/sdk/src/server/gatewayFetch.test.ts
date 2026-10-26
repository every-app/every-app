import { afterEach, describe, expect, vi } from "vitest";
import { it } from "../../test/inOrganization";
import { DEV_AI_PROVIDERS } from "../internal/aiProviders";
import { ConfigurationError } from "../internal/index";
import { createGatewayFetch } from "./gatewayFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function providerRequest(headers?: HeadersInit): Request {
  return new Request(
    "https://gateway.example.com/api/ai/openai/v1/responses?stream=true",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
    },
  );
}

describe("createGatewayFetch", () => {
  it("prefers the binding, strips Authorization, and forwards inbound identity", async () => {
    const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ via: "binding" }),
    );
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);
    const gatewayFetch = createGatewayFetch({
      env: {
        EVERY_APP_GATEWAY: { fetch: bindingFetch },
        OPENAI_API_KEY: "developer-key",
      },
      for: new Request("https://chef.example.com/api/chat", {
        headers: { "x-everyapp-identity": "signed-user-identity" },
      }),
    });

    const response = await gatewayFetch(
      providerRequest({ authorization: "Bearer gateway-managed" }),
    );

    await expect(response.json()).resolves.toEqual({ via: "binding" });
    expect(directFetch).not.toHaveBeenCalled();
    const forwarded = bindingFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "http://every-app-gateway.internal/api/ai/openai/v1/responses?stream=true",
    );
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
  });

  it("uses a developer key for direct OpenAI fetch when the binding is absent", async () => {
    const directFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ via: "direct" }),
    );
    vi.stubGlobal("fetch", directFetch);
    const gatewayFetch = createGatewayFetch({
      env: { EVERYAPP_DEV: "1", OPENAI_API_KEY: "developer-key" },
      for: new Request("http://localhost/api/chat", {
        headers: { "x-everyapp-identity": "local-identity" },
      }),
    });

    const response = await gatewayFetch(
      providerRequest({
        authorization: "Bearer gateway-managed",
        "x-everyapp-identity": "spoofed-outbound-identity",
      }),
    );

    await expect(response.json()).resolves.toEqual({ via: "direct" });
    const forwarded = directFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "https://api.openai.com/v1/responses?stream=true",
    );
    expect(forwarded?.headers.get("authorization")).toBe(
      "Bearer developer-key",
    );
    expect(forwarded?.headers.get("x-everyapp-identity")).toBeNull();
  });

  it("reaches OpenRouter with a developer key when the binding is absent", async () => {
    const directFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ via: "direct" }),
    );
    vi.stubGlobal("fetch", directFetch);
    const gatewayFetch = createGatewayFetch({
      env: { EVERYAPP_DEV: "1", OPENROUTER_API_KEY: "developer-key" },
    });

    await gatewayFetch(
      "https://gateway.example.com/api/ai/openrouter/api/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    const forwarded = directFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(forwarded?.headers.get("authorization")).toBe(
      "Bearer developer-key",
    );
  });

  it("names the missing key when local dev has another provider's only", async () => {
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);
    const gatewayFetch = createGatewayFetch({
      env: { EVERYAPP_DEV: "1", OPENAI_API_KEY: "developer-key" },
    });

    await expect(
      gatewayFetch(
        "https://gateway.example.com/api/ai/openrouter/api/v1/chat/completions",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toThrow(/Set OPENROUTER_API_KEY in \.dev\.vars/);
    // A provider the catalog doesn't have: the message names every AI
    // provider it does, the three it always named first.
    const unknown = await gatewayFetch(
      "https://gateway.example.com/api/ai/nope/v1/messages",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(unknown).toBeInstanceOf(ConfigurationError);
    expect((unknown as Error).message).toMatch(
      /\/api\/ai\/openai, \/api\/ai\/openrouter, \/api\/ai\/workers-ai/,
    );
    for (const id of Object.keys(DEV_AI_PROVIDERS)) {
      expect((unknown as Error).message).toContain(`/api/ai/${id}`);
    }
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("reaches Workers AI under the account's path with the developer's token", async () => {
    const directFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ via: "direct" }),
    );
    vi.stubGlobal("fetch", directFetch);
    const gatewayFetch = createGatewayFetch({
      env: {
        EVERYAPP_DEV: "1",
        WORKERS_AI_API_TOKEN: " developer-token ",
        CLOUDFLARE_ACCOUNT_ID: "acc123",
      },
    });

    await gatewayFetch(
      "http://every-app-gateway.internal/api/ai/workers-ai/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    const forwarded = directFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions",
    );
    expect(forwarded?.headers.get("authorization")).toBe(
      "Bearer developer-token",
    );
  });

  it("needs both Workers AI settings in local dev, and names them", async () => {
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);

    // The token alone: no provider is reachable.
    expect(() =>
      createGatewayFetch({
        env: { EVERYAPP_DEV: "1", WORKERS_AI_API_TOKEN: "developer-token" },
      }),
    ).toThrow(/WORKERS_AI_API_TOKEN with CLOUDFLARE_ACCOUNT_ID/);

    // Another provider's key: Workers AI calls name what is missing.
    const gatewayFetch = createGatewayFetch({
      env: {
        EVERYAPP_DEV: "1",
        OPENAI_API_KEY: "developer-key",
        CLOUDFLARE_ACCOUNT_ID: "acc123",
      },
    });
    await expect(
      gatewayFetch(
        "https://gateway.example.com/api/ai/workers-ai/v1/chat/completions",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toThrow(
      new ConfigurationError(
        "Set WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .dev.vars to call workers-ai in local development.",
      ),
    );
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("stringifies Workers AI's numeric tokens in dev as the gateway does", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":" of "}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":18}}]}',
      "data: [DONE]",
    ];
    const upstream = () =>
      new Response(sse.join("\n\n") + "\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstream()),
    );
    const gatewayFetch = createGatewayFetch({
      env: {
        EVERYAPP_DEV: "1",
        WORKERS_AI_API_TOKEN: "developer-token",
        CLOUDFLARE_ACCOUNT_ID: "acc123",
        OPENROUTER_API_KEY: "developer-key",
      },
    });

    const workersAi = await gatewayFetch(
      "https://gateway.example.com/api/ai/workers-ai/v1/chat/completions",
      { method: "POST", body: "{}" },
    );
    expect((await workersAi.text()).split("\n\n").slice(0, 3)).toEqual([
      sse[0],
      'data: {"choices":[{"index":0,"delta":{"content":"18"}}]}',
      sse[2],
    ]);

    // Only Workers AI's answers.
    const openrouter = await gatewayFetch(
      "https://gateway.example.com/api/ai/openrouter/api/v1/chat/completions",
      { method: "POST", body: "{}" },
    );
    await expect(openrouter.text()).resolves.toBe(sse.join("\n\n") + "\n\n");
  });

  it("rejects a production-shaped env even when a provider key is present", () => {
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);

    expect(() =>
      createGatewayFetch({
        env: { OPENAI_API_KEY: "production-key" },
        for: new Request("https://chef.example.com/api/chat"),
      }),
    ).toThrowError(ConfigurationError);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("removes an outbound identity when the inbound request has none", async () => {
    const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ ok: true }),
    );
    const gatewayFetch = createGatewayFetch({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      for: new Request("https://chef.example.com/background-job"),
    });

    await gatewayFetch(
      providerRequest({ "x-everyapp-identity": "app-supplied-value" }),
    );

    expect(
      bindingFetch.mock.calls[0]?.[0]?.headers.get("x-everyapp-identity"),
    ).toBeNull();
  });

  it("streams request bodies to the binding without buffering them", async () => {
    let closeBody: (() => void) | undefined;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        closeBody = () => controller.close();
      },
    });
    const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
      async (request) => {
        expect(request.body).not.toBeNull();
        return Response.json({ accepted: true });
      },
    );
    const gatewayFetch = createGatewayFetch({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      for: new Request("https://chef.example.com/api/chat"),
    });

    const response = await gatewayFetch(
      "https://gateway.example.com/api/ai/openai/v1/files",
      {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    closeBody?.();

    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("propagates an AbortSignal to cancel the binding call", async () => {
    const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
      (request) =>
        new Promise((_resolve, reject) => {
          const rejectAborted = () => reject(request.signal.reason);
          if (request.signal.aborted) rejectAborted();
          else
            request.signal.addEventListener("abort", rejectAborted, {
              once: true,
            });
        }),
    );
    const gatewayFetch = createGatewayFetch({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      for: new Request("https://chef.example.com/api/chat"),
    });
    const controller = new AbortController();

    const response = gatewayFetch(
      "https://gateway.example.com/api/ai/openai/v1/responses",
      {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      },
    );
    controller.abort(new Error("caller cancelled"));

    await expect(response).rejects.toThrow("caller cancelled");
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(bindingFetch.mock.calls[0]?.[0]?.signal.aborted).toBe(true);
  });

  it("throws a clear structured configuration error without binding or key", () => {
    expect(() =>
      createGatewayFetch({
        env: {},
        for: new Request("http://localhost/api/chat"),
      }),
    ).toThrowError(ConfigurationError);
    expect(() =>
      createGatewayFetch({
        env: {},
        for: new Request("http://localhost/api/chat"),
      }),
    ).toThrow(/EVERY_APP_GATEWAY.*OPENAI_API_KEY/);
  });
});
