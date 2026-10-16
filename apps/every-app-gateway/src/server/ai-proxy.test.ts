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
      error: "Provider not supported",
    });
  });

  it("returns 503 when provider secret is not configured", async () => {
    const response = await handleAuthenticatedAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses", { method: "POST" }),
      provider: "openai",
      env: {},
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provider is not configured",
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
      error: "Invalid proxy request path",
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
