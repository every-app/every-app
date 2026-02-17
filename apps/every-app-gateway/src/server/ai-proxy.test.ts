import { describe, expect, it, vi } from "vitest";
import {
  GatewayAuthError,
  type GatewayAuthContext,
} from "./gateway-auth-policy";
import { handleAiProxyRequest } from "./ai-proxy";

function createRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://gateway.example.com${path}`, init);
}

describe("handleAiProxyRequest", () => {
  it("returns 404 for unknown provider", async () => {
    const response = await handleAiProxyRequest({
      request: createRequest("/api/ai/unknown/v1/responses", {
        method: "POST",
      }),
      provider: "unknown",
      env: { OPENAI_API_KEY: "key" },
      authenticate: vi.fn(),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provider not supported",
    });
  });

  it("maps gateway auth errors to HTTP status and JSON response", async () => {
    const authenticate = vi
      .fn()
      .mockRejectedValue(new GatewayAuthError("invalid_app_token"));

    const response = await handleAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses", { method: "POST" }),
      provider: "openai",
      env: { OPENAI_API_KEY: "key" },
      authenticate,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unauthorized",
      code: "invalid_app_token",
    });
  });

  it("returns 503 when provider secret is not configured", async () => {
    const authenticate = vi
      .fn<() => Promise<GatewayAuthContext>>()
      .mockResolvedValue({
        authType: "app",
        appId: "chef",
        appToken: "app-token",
        appTokenPayload: {
          appId: "chef",
          scopes: ["provider:openai"],
          tokenId: "token-1",
        },
      });

    const response = await handleAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses", { method: "POST" }),
      provider: "openai",
      env: {},
      authenticate,
    });

    expect(authenticate).toHaveBeenCalled();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provider is not configured",
    });
  });

  it("rejects proxy paths that attempt to override upstream host", async () => {
    const authenticate = vi
      .fn<() => Promise<GatewayAuthContext>>()
      .mockResolvedValue({
        authType: "app",
        appId: "chef",
        appToken: "app-token",
        appTokenPayload: {
          appId: "chef",
          scopes: ["provider:openai"],
          tokenId: "token-1",
        },
      });

    const fetchUpstream = vi.fn();

    const response = await handleAiProxyRequest({
      request: createRequest("/api/ai/openai//attacker.example/collect", {
        method: "POST",
      }),
      provider: "openai",
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      authenticate,
      fetchUpstream,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid proxy request path",
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("forwards request to OpenAI with gateway-managed key and strips internal headers", async () => {
    const authenticate = vi
      .fn<() => Promise<GatewayAuthContext>>()
      .mockResolvedValue({
        authType: "app",
        appId: "chef",
        appToken: "app-token",
        appTokenPayload: {
          appId: "chef",
          scopes: ["provider:openai"],
          tokenId: "token-1",
        },
      });

    const fetchUpstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await handleAiProxyRequest({
      request: createRequest("/api/ai/openai/v1/responses?stream=true", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-every-app-token": "app-token",
          "x-user-id": "attacker-user",
          "x-user-email": "attacker@example.com",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
      }),
      provider: "openai",
      env: { OPENAI_API_KEY: "gateway-secret-key" },
      authenticate,
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
    expect(forwardedRequest.headers.get("connection")).toBeNull();
    expect(forwardedRequest.headers.get("transfer-encoding")).toBeNull();
    expect(forwardedRequest.headers.get("x-forwarded-for")).toBeNull();
  });
});
