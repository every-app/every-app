import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_TOKEN_HEADER,
  authenticateGatewayRequest,
  GatewayAuthError,
  type AppTokenPayload,
} from "./gateway-auth-policy";

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.example.com/api/ai/openai/chat", {
    headers: new Headers(headers),
  });
}

describe("authenticateGatewayRequest", () => {
  const verifyAppToken =
    vi.fn<(token: string) => Promise<AppTokenPayload | null>>();

  beforeEach(() => {
    verifyAppToken.mockReset();
  });

  it("authenticates with app token when no Authorization header is present", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:openai"],
      tokenId: "token-1",
    });

    const result = await authenticateGatewayRequest({
      request: createRequest({
        [APP_TOKEN_HEADER]: "valid-app-token",
      }),
      provider: "openai",
      verifyAppToken,
    });

    expect(result.authType).toBe("app");
    expect(result.appId).toBe("chef");
    expect(result.appTokenPayload.tokenId).toBe("token-1");
    expect(verifyAppToken).toHaveBeenCalledWith("valid-app-token");
  });

  it("rejects requests with an Authorization header", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:*"],
    });

    await expect(
      authenticateGatewayRequest({
        request: createRequest({
          authorization: "Bearer some-session-token",
          [APP_TOKEN_HEADER]: "valid-app-token",
        }),
        provider: "openai",
        verifyAppToken,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "unexpected_authorization_header",
        status: 400,
      }),
    );

    expect(verifyAppToken).not.toHaveBeenCalled();
  });

  it("rejects malformed Authorization header without falling back to app token", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:*"],
    });

    await expect(
      authenticateGatewayRequest({
        request: createRequest({
          authorization: "Basic dXNlcjpwYXNz",
          [APP_TOKEN_HEADER]: "app-token",
        }),
        provider: "openai",
        verifyAppToken,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "unexpected_authorization_header",
      }),
    );

    expect(verifyAppToken).not.toHaveBeenCalled();
  });

  it("rejects app token without provider scope", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:anthropic"],
    });

    await expect(
      authenticateGatewayRequest({
        request: createRequest({
          [APP_TOKEN_HEADER]: "app-token",
        }),
        provider: "openai",
        verifyAppToken,
      }),
    ).rejects.toEqual(new GatewayAuthError("insufficient_scope"));
  });

  it("accepts app token with wildcard provider scope", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:*"],
    });

    const result = await authenticateGatewayRequest({
      request: createRequest({
        [APP_TOKEN_HEADER]: "app-token",
      }),
      provider: "openai",
      verifyAppToken,
    });

    expect(result.authType).toBe("app");
    expect(result.appId).toBe("chef");
  });

  it("accepts legacy wildcard scope format", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["providers:*"],
    });

    const result = await authenticateGatewayRequest({
      request: createRequest({
        [APP_TOKEN_HEADER]: "app-token",
      }),
      provider: "openai",
      verifyAppToken,
    });

    expect(result.authType).toBe("app");
    expect(result.appId).toBe("chef");
  });

  it("rejects requests with no credentials", async () => {
    await expect(
      authenticateGatewayRequest({
        request: createRequest(),
        provider: "openai",
        verifyAppToken,
      }),
    ).rejects.toEqual(new GatewayAuthError("missing_credentials"));

    expect(verifyAppToken).not.toHaveBeenCalled();
  });

  it("supports custom app token header names", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:*"],
    });

    const result = await authenticateGatewayRequest({
      request: createRequest({
        "x-custom-app-token": "custom-token",
      }),
      provider: "openai",
      verifyAppToken,
      appTokenHeader: "x-custom-app-token",
    });

    expect(result.authType).toBe("app");
    expect(verifyAppToken).toHaveBeenCalledWith("custom-token");
  });

  it("normalizes app token scope matching for case and whitespace", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["  provider:OpenAI  "],
    });

    const result = await authenticateGatewayRequest({
      request: createRequest({
        [APP_TOKEN_HEADER]: "app-token",
      }),
      provider: " openai ",
      verifyAppToken,
    });

    expect(result.authType).toBe("app");
  });

  it("does not treat app-supplied user headers as authenticated user identity", async () => {
    verifyAppToken.mockResolvedValue({
      appId: "chef",
      scopes: ["provider:*"],
    });

    const result = await authenticateGatewayRequest({
      request: createRequest({
        [APP_TOKEN_HEADER]: "app-token",
        "x-user-id": "attacker-user",
        "x-user-email": "attacker@example.com",
      }),
      provider: "openai",
      verifyAppToken,
    });

    expect(result.authType).toBe("app");
    expect("userId" in result).toBe(false);
    expect("email" in result).toBe(false);
  });
});
