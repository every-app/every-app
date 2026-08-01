import { describe, expect, it, vi } from "vitest";
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
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      fetchUpstream,
    });
    closeBody?.();

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });
});
