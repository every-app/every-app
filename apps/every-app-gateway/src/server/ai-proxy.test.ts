import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAuthenticatedAiProxyRequest } from "./ai-proxy";

function createRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://gateway.example.com${path}`, init);
}

describe("handleAuthenticatedAiProxyRequest", () => {
  it("returns 404 for unknown provider", async () => {
    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/unknown/v1/responses", {
        method: "POST",
      }),
      provider: "unknown",
      env: { OPENAI_API_KEY: "key" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "ai_provider_not_supported",
      error: { message: expect.stringContaining("Provider not supported") },
    });
  });

  it("returns 503 when provider secret is not configured", async () => {
    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses", { method: "POST" }),
      provider: "openai",
      env: {},
      setupCommand: "pnpm everyapp configure notes",
    });

    const setup =
      "OpenAI isn't set up on this Gateway: it needs OPENAI_API_KEY. An admin runs: pnpm everyapp configure notes";
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "ai_provider_not_configured",
      message: setup,
      settings: ["OPENAI_API_KEY"],
      setup,
      command: "pnpm everyapp configure notes",
      // An OpenAI SDK's APIError.error is this object: the same fields.
      error: {
        code: "ai_provider_not_configured",
        type: "gateway_refusal",
        message: setup,
        settings: ["OPENAI_API_KEY"],
        setup,
        command: "pnpm everyapp configure notes",
      },
    });
  });

  it("rejects proxy paths that attempt to override upstream host", async () => {
    const fetchUpstream = vi.fn();

    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai//attacker.example/collect", {
        method: "POST",
      }),
      provider: "openai",
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      fetchUpstream,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "ai_request_invalid",
      message: "Invalid proxy request path",
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("forwards request to OpenAI with gateway-managed key and strips internal headers", async () => {
    const fetchUpstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses?stream=true", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-every-app-token": "app-token",
          "x-user-id": "attacker-user",
          "x-user-email": "attacker@example.com",
          "x-everyapp-identity": "signed-user-identity",
          "x-everyapp-public": "signed-public-marker",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "x-forwarded-for": "1.2.3.4",
          "x-api-key": "app-held-key",
          "openai-organization": "org-app-chosen",
          "openai-project": "proj_app_chosen",
          "Anthropic-Workspace-Id": "wrkspc_app_chosen",
          "X-HF-Bill-To": "someone-elses-org",
          "anthropic-version": "2023-06-01",
          "cf-aig-cache-key": "another-apps-cache",
          "cf-aig-metadata": '{"org":"someone-else"}',
          "x-everyapp-org": "org-forged",
          "x-everyapp-anything": "forged",
        },
        body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
      }),
      provider: "openai",
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      fetchUpstream,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "ok" });

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [forwardedArg] = fetchUpstream.mock.calls[0];
    const forwardedRequest = forwardedArg as Request;
    expect(forwardedRequest.url).toBe(
      "https://api.openai.com/v1/responses?stream=true",
    );
    expect(forwardedRequest.headers.get("authorization")).toBe(
      "Bearer gateway-secret-key",
    );
    expect(forwardedRequest.headers.get("x-user-id")).toBeNull();
    expect(forwardedRequest.headers.get("x-user-email")).toBeNull();
    expect(forwardedRequest.headers.get("x-every-app-token")).toBeNull();
    expect(forwardedRequest.headers.get("x-everyapp-identity")).toBeNull();
    expect(forwardedRequest.headers.get("x-everyapp-public")).toBeNull();
    expect(forwardedRequest.headers.get("connection")).toBeNull();
    expect(forwardedRequest.headers.get("transfer-encoding")).toBeNull();
    expect(forwardedRequest.headers.get("x-forwarded-for")).toBeNull();
    expect(forwardedRequest.headers.get("x-api-key")).toBeNull();
    expect(forwardedRequest.headers.get("openai-organization")).toBeNull();
    expect(forwardedRequest.headers.get("openai-project")).toBeNull();
    expect(forwardedRequest.headers.get("anthropic-workspace-id")).toBeNull();
    expect(forwardedRequest.headers.get("x-hf-bill-to")).toBeNull();
    // Benign provider headers pass.
    expect(forwardedRequest.headers.get("anthropic-version")).toBe(
      "2023-06-01",
    );
    const forwardedNames = [...forwardedRequest.headers.keys()];
    expect(
      forwardedNames.filter(
        (name) => name.startsWith("cf-aig-") || name.startsWith("x-everyapp-"),
      ),
    ).toEqual([]);
    expect(forwardedRequest.headers.get("content-type")).toBe(
      "application/json",
    );
  });

  it("streams request bodies upstream without waiting for the body to finish", async () => {
    let closeBody: (() => void) | undefined;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        closeBody = () => controller.close();
      },
    });
    const fetchUpstream = vi.fn<(request: Request) => Promise<Response>>(
      async (request) => {
        expect(request.body).not.toBeNull();
        return Response.json({ accepted: true });
      },
    );

    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/files", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      provider: "openai",
      // Outside inference, only routes the operator allows and the manifest
      // opts into, streamed.
      env: {
        OPENAI_API_KEY: "gateway-secret-key",
        AI_PROXY_EXTRA_ROUTES: "/v1/files",
      },
      policy: { routes: ["/v1/files"] },
      fetchUpstream,
    });
    closeBody?.();

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });
});

describe("AI proxy lockdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function call(
    path: string,
    init: RequestInit = {},
    policy?: { models?: string[]; routes?: string[] },
    operatorRoutes?: string,
  ) {
    const fetchUpstream = vi.fn(async (_request: Request) =>
      Response.json(
        { id: "resp_1", usage: { input_tokens: 12, output_tokens: 5 } },
        { headers: { "x-request-id": "req_123" } },
      ),
    );
    const response = handleAuthenticatedAiProxyRequest({
      request: createRequest(`/api/ai/openai${path}`, init),
      provider: "openai",
      env: {
        OPENAI_API_KEY: "gateway-secret-key",
        AI_PROXY_EXTRA_ROUTES: operatorRoutes,
      },
      policy,
      caller: { organizationId: "org-1", appId: "chef" },
      fetchUpstream,
    });
    return { response, fetchUpstream };
  }

  function jsonPost(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  it("rejects non-inference endpoints (files, batches, stored responses)", async () => {
    for (const [method, path] of [
      ["GET", "/v1/files"],
      ["POST", "/v1/files"],
      ["POST", "/v1/batches"],
      ["POST", "/v1/fine_tuning/jobs"],
      ["GET", "/v1/responses/resp_1"],
      ["GET", "/v1/chat/completions"],
      ["POST", "/v1/assistants"],
    ] as const) {
      const { response, fetchUpstream } = call(path, { method });
      const result = await response;
      expect(result.status).toBe(403);
      await expect(result.json()).resolves.toMatchObject({
        code: "ai_route_not_allowed",
      });
      expect(fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("allows extra endpoints the operator allows and the manifest opts into", async () => {
    const { response, fetchUpstream } = call(
      "/v1/files/file_1",
      { method: "GET" },
      { routes: ["/v1/files"] },
      "/v1/batches, /v1/files",
    );
    expect((await response).status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it("ignores a manifest's opt-in the operator has not allowed", async () => {
    for (const operatorRoutes of [
      undefined,
      "",
      "/v1/batches",
      "/v1/files/file_2",
      "files",
    ]) {
      const { response, fetchUpstream } = call(
        "/v1/files/file_1",
        { method: "GET" },
        { routes: ["/v1/files"] },
        operatorRoutes,
      );
      const result = await response;
      expect(result.status).toBe(403);
      await expect(result.json()).resolves.toMatchObject({
        code: "ai_route_not_allowed",
      });
      expect(fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("needs the app's opt-in too, whatever the operator allows", async () => {
    const { response, fetchUpstream } = call(
      "/v1/files",
      { method: "GET" },
      undefined,
      "/v1/files",
    );
    expect((await response).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("forces store:false on responses and chat completions", async () => {
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      const { response, fetchUpstream } = call(
        path,
        jsonPost({ model: "gpt-5.2", input: "hi", store: true }),
      );
      expect((await response).status).toBe(200);
      const upstream = fetchUpstream.mock.calls[0]![0];
      await expect(upstream.json()).resolves.toMatchObject({
        model: "gpt-5.2",
        store: false,
      });
    }
  });

  it("leaves other inference bodies as they are", async () => {
    const { response, fetchUpstream } = call(
      "/v1/embeddings",
      jsonPost({ model: "text-embedding-3-small", input: "hi" }),
    );
    expect((await response).status).toBe(200);
    await expect(fetchUpstream.mock.calls[0]![0].json()).resolves.toEqual({
      model: "text-embedding-3-small",
      input: "hi",
    });
  });

  it("enforces the manifest's model allowlist", async () => {
    const policy = { models: ["gpt-5.2"] };
    const allowed = call(
      "/v1/responses",
      jsonPost({ model: "gpt-5.2", input: "x" }),
      policy,
    );
    expect((await allowed.response).status).toBe(200);

    for (const body of [{ model: "o3-pro", input: "x" }, { input: "x" }]) {
      const denied = call("/v1/responses", jsonPost(body), policy);
      const result = await denied.response;
      expect(result.status).toBe(403);
      await expect(result.json()).resolves.toMatchObject({
        code: "model_not_allowed",
      });
      expect(denied.fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("does not apply the model allowlist to opted-in endpoints", async () => {
    const { response, fetchUpstream } = call(
      "/v1/files",
      { method: "GET" },
      { models: ["gpt-5.2"], routes: ["/v1/files"] },
      "/v1/files",
    );
    expect((await response).status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
  });

  it.each([
    "/v1/files/x/..%2F..%2Fbatches",
    "/v1/files/x%2F..%2Fy",
    "/v1/chat%2Fcompletions",
    "/v1/files/x/..%2f..%2fbatches",
    "/v1/files/x%5C..%5Cy",
    "/v1/files/x%2E%2E/batches",
    "/v1/files/%252E%252E/batches",
  ])(
    "refuses a percent-encoded path separator (%s) before any route check, with /v1/files opened",
    async (path) => {
      const { response, fetchUpstream } = call(
        path,
        { method: "GET" },
        { routes: ["/v1/files"] },
        "/v1/files",
      );
      const result = await response;
      expect(result.status).toBe(400);
      expect(result.headers.get("x-everyapp-error")).toBe("ai_request_invalid");
      await expect(result.json()).resolves.toMatchObject({
        code: "ai_request_invalid",
      });
      expect(fetchUpstream).not.toHaveBeenCalled();
    },
  );

  function multipartPost(parts: [name: string, value: string][]): RequestInit {
    const form = new FormData();
    for (const [name, value] of parts) form.append(name, value);
    return { method: "POST", body: form };
  }

  it("refuses a multipart inference body with two model parts", async () => {
    const { response, fetchUpstream } = call(
      "/v1/audio/transcriptions",
      multipartPost([
        ["model", "whisper-1"],
        ["model", "gpt-4o-transcribe"],
        ["file", "audio"],
      ]),
      { models: ["whisper-1"] },
    );
    const result = await response;
    expect(result.status).toBe(400);
    expect(result.headers.get("x-everyapp-error")).toBe("ai_request_invalid");
    await expect(result.json()).resolves.toMatchObject({
      code: "ai_request_invalid",
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("forwards a multipart inference body with one allowed model part", async () => {
    const { response, fetchUpstream } = call(
      "/v1/audio/transcriptions",
      multipartPost([
        ["model", "whisper-1"],
        ["file", "audio"],
      ]),
      { models: ["whisper-1"] },
    );
    expect((await response).status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    const upstream = fetchUpstream.mock.calls[0]![0];
    const form = await upstream.formData();
    expect(form.getAll("model")).toEqual(["whisper-1"]);
    expect(form.get("file")).toBe("audio");
  });

  it("logs an upstream failure without the request it carried", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchUpstream = vi.fn(async (request: Request) => {
      throw Object.assign(new Error("network down"), { request });
    });

    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "hi" }),
      }),
      provider: "openai",
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      caller: { organizationId: "org-1", appId: "chef" },
      fetchUpstream,
    });

    expect(response.status).toBe(502);
    const output = consoleError.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("ai.proxy.upstream_failed");
    expect(output).toContain("network down");
    expect(output).not.toContain("gateway-secret-key");
  });

  it("rejects a non-JSON inference body", async () => {
    const { response } = call("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await response).status).toBe(400);
  });

  it("logs model, token usage and request id, never the prompt", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { response } = call(
      "/v1/responses",
      jsonPost({ model: "gpt-5.2", input: "my secret prompt" }),
    );
    const result = await response;
    await result.text();

    const line = log.mock.calls
      .map((args) => String(args[0]))
      .find((entry) => entry.includes("ai.proxy.usage"));
    expect(JSON.parse(line!)).toMatchObject({
      evt: "ai.proxy.usage",
      organizationId: "org-1",
      appId: "chef",
      route: "/v1/responses",
      model: "gpt-5.2",
      status: 200,
      requestId: "req_123",
      usage: { input: 12, output: 5, total: 17 },
    });
    expect(line).not.toContain("my secret prompt");
  });
});

describe("OpenRouter", () => {
  function call(path: string, init: RequestInit, models?: string[]) {
    const fetchUpstream = vi.fn(async (_request: Request) =>
      Response.json({ id: "gen-1" }),
    );
    const response = handleAuthenticatedAiProxyRequest({
      request: createRequest(`/api/ai/openrouter${path}`, init),
      provider: "openrouter",
      env: {
        OPENAI_API_KEY: "openai-key",
        OPENROUTER_API_KEY: "openrouter-key",
        AI_PROXY_EXTRA_ROUTES: "/v1/files",
      },
      policy: models ? { models } : undefined,
      fetchUpstream,
    });
    return { response, fetchUpstream };
  }

  const chat = (model: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] }),
  });

  it("forwards inference to openrouter.ai with the OpenRouter key", async () => {
    const { response, fetchUpstream } = call(
      "/api/v1/chat/completions",
      chat("openai/gpt-5-mini"),
    );

    expect((await response).status).toBe(200);
    const upstream = fetchUpstream.mock.calls[0]![0];
    expect(upstream.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(upstream.headers.get("authorization")).toBe("Bearer openrouter-key");
  });

  it("allows inference only, whatever the operator allows for OpenAI", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/credits"],
      ["GET", "/api/v1/keys"],
      ["POST", "/v1/files"],
    ] as const) {
      const { response, fetchUpstream } = call(path, { method });
      expect((await response).status).toBe(403);
      expect(fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("applies the manifest's model allowlist", async () => {
    const { response, fetchUpstream } = call(
      "/api/v1/chat/completions",
      chat("anthropic/claude-opus"),
      ["openai/gpt-5-mini"],
    );

    expect((await response).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("applies the allowlist to every `models` fallback too, and refuses a malformed list", async () => {
    const allowed = ["openai/gpt-5-mini", "anthropic/claude-haiku-5.5"];
    const withFallbacks = (models: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5-mini",
        models,
        route: "fallback",
        messages: [],
      }),
    });

    // A disallowed fallback is a disallowed model, named in the refusal.
    const denied = call(
      "/api/v1/chat/completions",
      withFallbacks(["anthropic/claude-haiku-5.5", "openrouter/auto"]),
      allowed,
    );
    const refused = await denied.response;
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "model_not_allowed",
      message: expect.stringContaining("openrouter/auto"),
    });
    expect(denied.fetchUpstream).not.toHaveBeenCalled();

    // Allowed fallbacks pass, as sent.
    const ok = call(
      "/api/v1/chat/completions",
      withFallbacks(["anthropic/claude-haiku-5.5"]),
      allowed,
    );
    expect((await ok.response).status).toBe(200);
    await expect(
      ok.fetchUpstream.mock.calls[0]![0].json(),
    ).resolves.toMatchObject({
      model: "openai/gpt-5-mini",
      models: ["anthropic/claude-haiku-5.5"],
    });

    // Something that isn't a list of names never reaches the provider.
    for (const malformed of ["openrouter/auto", [{ id: "x" }], 7]) {
      const bad = call(
        "/api/v1/chat/completions",
        withFallbacks(malformed),
        allowed,
      );
      expect((await bad.response).status).toBe(400);
      expect(bad.fetchUpstream).not.toHaveBeenCalled();
    }
  });
});

/** Live captures from Workers AI's /v1/chat/completions (llama-4-scout, 2026-10-17). */
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** An SSE answer delivered in small byte pieces, splitting events and characters. */
function sseResponse(text: string, pieceSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += pieceSize) {
          controller.enqueue(bytes.slice(i, i + pieceSize));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const sseEvents = (text: string) => text.split("\n\n").filter(Boolean);

describe("Workers AI", () => {
  const WORKERS_AI_ENV = {
    WORKERS_AI_API_TOKEN: "workers-ai-token",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
  };
  const LLAMA = "@cf/meta/llama-4-scout-17b-16e-instruct";

  function call(
    path: string,
    init: RequestInit,
    options: {
      env?: Record<string, string>;
      policy?: { models?: string[]; routes?: string[] };
      provider?: string;
      upstream?: () => Response;
    } = {},
  ) {
    const fetchUpstream = vi.fn(async (_request: Request) =>
      options.upstream ? options.upstream() : Response.json({ id: "chat-1" }),
    );
    const provider = options.provider ?? "workers-ai";
    const response = handleAuthenticatedAiProxyRequest({
      request: createRequest(`/api/ai/${provider}${path}`, init),
      provider,
      env: options.env ?? WORKERS_AI_ENV,
      policy: options.policy,
      caller: { organizationId: "org-1", appId: "agentic-inbox" },
      fetchUpstream,
    });
    return { response, fetchUpstream };
  }

  const chat = (model = LLAMA, stream = true): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [] }),
  });

  it("forwards chat completions under the gateway's account with its token", async () => {
    const { response, fetchUpstream } = call("/v1/chat/completions", chat());

    expect((await response).status).toBe(200);
    const upstream = fetchUpstream.mock.calls[0]![0];
    expect(upstream.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions",
    );
    expect(upstream.headers.get("authorization")).toBe(
      "Bearer workers-ai-token",
    );
    // Workers AI stores nothing, so the body goes as the app sent it.
    await expect(upstream.json()).resolves.toEqual({
      model: LLAMA,
      stream: true,
      messages: [],
    });
  });

  it("refuses 503 ai_provider_not_configured, naming both settings, while either is unset", async () => {
    for (const env of [
      {},
      { WORKERS_AI_API_TOKEN: "workers-ai-token" },
      { CLOUDFLARE_ACCOUNT_ID: "acc123" },
      { WORKERS_AI_API_TOKEN: "workers-ai-token", CLOUDFLARE_ACCOUNT_ID: " " },
      // Another provider's key is no help.
      { OPENAI_API_KEY: "openai-key", CLOUDFLARE_ACCOUNT_ID: "acc123" },
    ] as Record<string, string>[]) {
      const { response, fetchUpstream } = call("/v1/chat/completions", chat(), {
        env,
      });
      const result = await response;
      expect(result.status, JSON.stringify(env)).toBe(503);
      expect(result.headers.get("x-everyapp-error")).toBe(
        "ai_provider_not_configured",
      );
      await expect(result.json()).resolves.toMatchObject({
        code: "ai_provider_not_configured",
        error: {
          message:
            "Workers AI isn't set up on this Gateway: it needs WORKERS_AI_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The Gateway's operator sets them.",
          settings: ["WORKERS_AI_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
          code: "ai_provider_not_configured",
          type: "gateway_refusal",
        },
      });
      expect(fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("enforces the manifest's ai.models on @cf model ids", async () => {
    const policy = { models: [LLAMA] };
    const allowed = call("/v1/chat/completions", chat(LLAMA), { policy });
    expect((await allowed.response).status).toBe(200);

    const denied = call(
      "/v1/chat/completions",
      chat("@cf/moonshotai/kimi-k2.6"),
      {
        policy,
      },
    );
    const result = await denied.response;
    expect(result.status).toBe(403);
    expect(result.headers.get("x-everyapp-error")).toBe("model_not_allowed");
    await expect(result.json()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("@cf/moonshotai/kimi-k2.6"),
        code: "model_not_allowed",
      },
    });
    expect(denied.fetchUpstream).not.toHaveBeenCalled();
  });

  it("serves the OpenAI-compatible inference routes only", async () => {
    for (const path of ["/v1/embeddings", "/v1/responses"]) {
      const { response } = call(path, chat());
      expect((await response).status, path).toBe(200);
    }
    for (const [method, path] of [
      ["POST", `/v1/run/${LLAMA}`],
      ["POST", `/run/${LLAMA}`],
      ["GET", "/v1/chat/completions"],
      ["GET", "/v1/models"],
      ["POST", "/v1/files"],
      ["GET", "/finetunes"],
    ] as const) {
      const { response, fetchUpstream } = call(
        path,
        method === "POST" ? { ...chat(), method } : { method },
        {
          // Neither the operator nor the manifest widens Workers AI.
          env: { ...WORKERS_AI_ENV, AI_PROXY_EXTRA_ROUTES: "/v1/files" },
          policy: { routes: ["/v1/files"] },
        },
      );
      const result = await response;
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(result.headers.get("x-everyapp-error")).toBe(
        "ai_route_not_allowed",
      );
      expect(fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("turns the captured numeric token into a string and keeps every other event byte for byte", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const captured = fixture("workers-ai-llama-step2.sse");
    expect(captured).toContain('"delta":{"content":18}');
    const { response } = call("/v1/chat/completions", chat(), {
      upstream: () => sseResponse(captured),
    });

    const result = await response;
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    const out = sseEvents(await result.text());
    const input = sseEvents(captured);
    expect(out).toHaveLength(input.length);
    const chunks = out
      .filter((event) => event !== "data: [DONE]")
      .map((event) => JSON.parse(event.slice("data: ".length)));
    for (const chunk of chunks) {
      const content = chunk.choices[0].delta.content;
      if (content !== undefined) expect(typeof content).toBe("string");
    }
    expect(
      chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""),
    ).toBe(
      "The current weather in Paris is light rain with a temperature of 18°C.",
    );
    // Only the numeric event changed; [DONE] and the usage chunks did not.
    const changed = out.filter((event, i) => event !== input[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('"delta":{"content":"18"}');
    expect(out.at(-1)).toBe("data: [DONE]");

    // Usage is still read off the tail.
    const usage = log.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes("ai.proxy.usage"));
    expect(JSON.parse(usage!)).toMatchObject({
      provider: "workers-ai",
      route: "/v1/chat/completions",
      model: LLAMA,
      usage: { input: 206, output: 17, total: 223 },
    });
  });

  it("leaves streamed tool calls, usage and [DONE] byte for byte", async () => {
    const captured = fixture("workers-ai-llama-step1.sse");
    expect(captured).toContain('"tool_calls"');
    const { response } = call("/v1/chat/completions", chat(), {
      upstream: () => sseResponse(captured, 3),
    });

    await expect((await response).text()).resolves.toBe(captured);
  });

  it("leaves reasoning_content byte for byte", async () => {
    // kimi-k2.6's shape: reasoning first (null, then text), then a tool call.
    const kimi =
      [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null},"matched_stop":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":null,"reasoning_content":" The user wants 18 things"}}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"id":"functions.get_weather:0","index":0,"type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"limit\\": 25}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":80,"completion_tokens":60,"total_tokens":140}}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    const { response } = call("/v1/chat/completions", chat(), {
      upstream: () => sseResponse(kimi),
    });

    await expect((await response).text()).resolves.toBe(kimi);
  });

  it("does not normalise OpenAI's or OpenRouter's answers", async () => {
    const captured = fixture("workers-ai-llama-step2.sse");
    for (const [provider, path, env] of [
      ["openai", "/v1/chat/completions", { OPENAI_API_KEY: "openai-key" }],
      [
        "openrouter",
        "/api/v1/chat/completions",
        { OPENROUTER_API_KEY: "openrouter-key" },
      ],
    ] as const) {
      const { response } = call(path, chat("gpt-5.2"), {
        provider,
        env,
        upstream: () => sseResponse(captured),
      });
      await expect((await response).text(), provider).resolves.toBe(captured);
    }
  });
});

describe("AI proxy refusals", () => {
  it("carry x-everyapp-error and OpenAI's error shape, code and message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const json = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const cases: [
      provider: string,
      path: string,
      init: RequestInit,
      policy: { models?: string[] },
      status: number,
      code: string,
    ][] = [
      ["nope", "/v1/messages", json({}), {}, 404, "ai_provider_not_supported"],
      [
        "workers-ai",
        "/v1/chat/completions",
        json({}),
        {},
        503,
        "ai_provider_not_configured",
      ],
      ["openai", "//evil.example/x", json({}), {}, 400, "ai_request_invalid"],
      [
        "openai",
        "/v1/responses",
        { method: "POST", body: "not json" },
        {},
        400,
        "ai_request_invalid",
      ],
      [
        "openai",
        "/v1/files",
        { method: "GET" },
        {},
        403,
        "ai_route_not_allowed",
      ],
      [
        "openai",
        "/v1/responses",
        json({ model: "o3-pro" }),
        { models: ["gpt-5.2"] },
        403,
        "model_not_allowed",
      ],
      [
        "openai",
        "/v1/responses",
        json({ model: "gpt-5.2" }),
        {},
        502,
        "ai_upstream_failed",
      ],
    ];
    for (const [provider, path, init, policy, status, code] of cases) {
      const response = await handleAuthenticatedAiProxyRequest({
        request: createRequest(`/api/ai/${provider}${path}`, init),
        provider,
        env: { OPENAI_API_KEY: "gateway-secret-key" },
        policy,
        fetchUpstream: async () => {
          throw new Error("network down");
        },
      });
      expect(response.status, code).toBe(status);
      expect(response.headers.get("x-everyapp-error"), code).toBe(code);
      const body = (await response.json()) as { message: string };
      // A "not set up" refusal also carries what to set (setup-info.ts).
      const setup =
        code === "ai_provider_not_configured"
          ? {
              settings: expect.any(Array),
              setup: body.message,
              command: null,
            }
          : {};
      expect(body, code).toEqual({
        error: {
          message: body.message,
          code,
          type: "gateway_refusal",
          ...setup,
        },
        code,
        message: expect.any(String),
        ...setup,
      });
      expect(body.message.length, code).toBeGreaterThan(0);
    }
  });

  it("are not added to the provider's own errors", async () => {
    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.2" }),
      }),
      provider: "openai",
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      fetchUpstream: async () =>
        Response.json(
          { error: { message: "Rate limited", type: "requests" } },
          { status: 429 },
        ),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-everyapp-error")).toBeNull();
  });
});
