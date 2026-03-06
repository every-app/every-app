import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAiGatewayAuthenticator } from "./ai-gateway-auth";
import { APP_TOKEN_HEADER, GatewayAuthError } from "./gateway-auth-policy";

vi.mock("./repositories/AppTokenRepository", () => ({
  AppTokenRepository: {
    findActiveByTokenHash: vi.fn(),
    touchLastUsed: vi.fn(),
  },
}));

vi.mock("./app-token-hash", () => ({
  hashAppToken: vi.fn(),
}));

import { AppTokenRepository } from "./repositories/AppTokenRepository";
import { hashAppToken } from "./app-token-hash";

const mockAppTokenRepository = vi.mocked(AppTokenRepository);
const mockHashAppToken = vi.mocked(hashAppToken);

type GatewayEnv = {
  BETTER_AUTH_SECRET: string;
};

beforeEach(() => {
  vi.clearAllMocks();

  mockAppTokenRepository.findActiveByTokenHash.mockResolvedValue(null);
  mockAppTokenRepository.touchLastUsed.mockResolvedValue(undefined);
  mockHashAppToken.mockResolvedValue("token-hash");
});

function buildEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    BETTER_AUTH_SECRET: "test-secret",
    ...overrides,
  };
}

function createRequest(headers: Record<string, string>): Request {
  return new Request("https://gateway.example.com/api/ai/openai/v1/responses", {
    method: "POST",
    headers: new Headers(headers),
    body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
  });
}

describe("createAiGatewayAuthenticator", () => {
  it("authenticates valid app token when no Authorization header is present", async () => {
    mockAppTokenRepository.findActiveByTokenHash.mockResolvedValue({
      id: "token-1",
      appId: "chef",
      organizationId: "org-123",
      scopes: ["provider:openai"],
    });
    const authenticate = createAiGatewayAuthenticator(buildEnv());

    const result = await authenticate({
      request: createRequest({ [APP_TOKEN_HEADER]: "plaintext-app-token" }),
      provider: "openai",
    });

    expect(result.authType).toBe("app");
    expect(result.appId).toBe("chef");
    expect(mockHashAppToken).toHaveBeenCalledWith(
      "plaintext-app-token",
      "test-secret",
    );
    expect(mockAppTokenRepository.touchLastUsed).toHaveBeenCalledWith(
      "token-1",
      "org-123",
    );
  });

  it("rejects requests that include an Authorization header", async () => {
    mockAppTokenRepository.findActiveByTokenHash.mockResolvedValue({
      id: "token-1",
      appId: "chef",
      organizationId: "org-123",
      scopes: ["provider:*"],
    });
    const authenticate = createAiGatewayAuthenticator(buildEnv());

    await expect(
      authenticate({
        request: createRequest({
          authorization: "Bearer some-token",
          [APP_TOKEN_HEADER]: "plaintext-app-token",
        }),
        provider: "openai",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "unexpected_authorization_header",
      }),
    );

    expect(mockAppTokenRepository.findActiveByTokenHash).not.toHaveBeenCalled();
  });

  it("rejects invalid app token", async () => {
    mockAppTokenRepository.findActiveByTokenHash.mockResolvedValue(null);
    const authenticate = createAiGatewayAuthenticator(buildEnv());

    await expect(
      authenticate({
        request: createRequest({
          [APP_TOKEN_HEADER]: "invalid-app-token",
        }),
        provider: "openai",
      }),
    ).rejects.toEqual(new GatewayAuthError("invalid_app_token"));
  });

  it("rejects app token without matching provider scope", async () => {
    mockAppTokenRepository.findActiveByTokenHash.mockResolvedValue({
      id: "token-1",
      appId: "chef",
      organizationId: "org-123",
      scopes: ["provider:anthropic"],
    });
    const authenticate = createAiGatewayAuthenticator(buildEnv());

    await expect(
      authenticate({
        request: createRequest({
          [APP_TOKEN_HEADER]: "plaintext-app-token",
        }),
        provider: "openai",
      }),
    ).rejects.toEqual(new GatewayAuthError("insufficient_scope"));
  });
});
