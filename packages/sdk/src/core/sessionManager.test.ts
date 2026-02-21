import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock import.meta.env before any imports
vi.stubEnv("VITE_GATEWAY_URL", "https://gateway.example.com");

describe("SessionManager", () => {
  let SessionManager: typeof import("./sessionManager").SessionManager;
  let mockPostMessage: ReturnType<typeof vi.fn>;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let addEventListenerSpy: ReturnType<typeof vi.fn>;
  let removeEventListenerSpy: ReturnType<typeof vi.fn>;

  // Helper function to simulate token responses from parent window
  function simulateTokenResponse(options: {
    token?: string;
    error?: string;
    expiresAt?: string;
    requestId?: string;
    origin?: string;
    type?: string;
  }) {
    if (!messageHandler) {
      throw new Error("messageHandler not initialized");
    }
    messageHandler({
      origin: options.origin ?? "https://gateway.example.com",
      data: {
        type: options.type ?? "SESSION_TOKEN_RESPONSE",
        requestId: options.requestId ?? "test-uuid-123",
        ...(options.token !== undefined && { token: options.token }),
        ...(options.error !== undefined && { error: options.error }),
        ...(options.expiresAt !== undefined && {
          expiresAt: options.expiresAt,
        }),
      },
    } as MessageEvent);
  }

  // Helper function to simulate malformed message events (for security edge case testing)
  function simulateMalformedMessage(origin: string | null, data: unknown) {
    if (!messageHandler) {
      throw new Error("messageHandler not initialized");
    }
    messageHandler({
      origin,
      data,
    } as MessageEvent);
  }

  function createJwtLikeToken(payload: Record<string, unknown>): string {
    return `header.${btoa(JSON.stringify(payload))}.signature`;
  }

  function createBase64UrlJwtLikeToken(
    payload: Record<string, unknown>,
  ): string {
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    return `header.${encoded}.signature`;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_GATEWAY_URL", "https://gateway.example.com");

    // Mock window and postMessage
    mockPostMessage = vi.fn();
    messageHandler = null;
    addEventListenerSpy = vi.fn((event: string, handler: Function) => {
      if (event === "message") {
        messageHandler = handler as (event: MessageEvent) => void;
      }
    });
    removeEventListenerSpy = vi.fn();

    vi.stubGlobal("window", {
      addEventListener: addEventListenerSpy,
      removeEventListener: removeEventListenerSpy,
      parent: {
        postMessage: mockPostMessage,
      },
    });

    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid-123",
    });

    // Import fresh module
    const module = await import("./sessionManager");
    SessionManager = module.SessionManager;
  });

  afterEach(() => {
    vi.useRealTimers(); // Safe to call even if real timers are active
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    messageHandler = null;
  });

  describe("constructor", () => {
    it("throws error when appId is not provided", () => {
      expect(() => new SessionManager({ appId: "" })).toThrow(
        "[SessionManager] appId is required.",
      );
    });

    it("throws error when VITE_GATEWAY_URL is not set", async () => {
      vi.resetModules();
      vi.stubEnv("VITE_GATEWAY_URL", "");

      const module = await import("./sessionManager");

      expect(() => new module.SessionManager({ appId: "test-app" })).toThrow(
        "[SessionManager] VITE_GATEWAY_URL env var is required.",
      );
    });

    it("throws error for invalid gateway URL", async () => {
      vi.resetModules();
      vi.stubEnv("VITE_GATEWAY_URL", "not-a-valid-url");

      const module = await import("./sessionManager");

      expect(() => new module.SessionManager({ appId: "test-app" })).toThrow(
        "[SessionManager] Invalid gateway URL: not-a-valid-url",
      );
    });

    it("successfully creates instance with valid config", () => {
      const manager = new SessionManager({ appId: "test-app" });

      expect(manager.appId).toBe("test-app");
      expect(manager.parentOrigin).toBe("https://gateway.example.com");
    });
  });

  describe("getTokenState", () => {
    it("returns NO_TOKEN when no token exists", () => {
      const manager = new SessionManager({ appId: "test-app" });

      const state = manager.getTokenState();

      expect(state.status).toBe("NO_TOKEN");
      expect(state.token).toBeNull();
    });

    it("returns VALID when token exists and is not expiring", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "valid-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(), // Expires in 60 seconds
      });

      await tokenPromise;

      const state = manager.getTokenState();

      expect(state.status).toBe("VALID");
      expect(state.token).toBe("valid-token");
    });

    it("returns EXPIRED when token is past expiration", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "expired-token",
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Already expired
      });

      await tokenPromise;

      const state = manager.getTokenState();

      expect(state.status).toBe("EXPIRED");
      expect(state.token).toBe("expired-token");
    });

    it("returns REFRESHING when token request is in progress", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // Start a request but don't complete it yet
      const tokenPromise = manager.requestNewToken();

      // Check state while request is pending
      const state = manager.getTokenState();

      expect(state.status).toBe("REFRESHING");
      expect(state.token).toBeNull();

      // Complete the request to clean up
      simulateTokenResponse({
        token: "token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;
    });
  });

  describe("requestNewToken", () => {
    it("sends correct postMessage to parent", async () => {
      const manager = new SessionManager({ appId: "my-app" });

      const tokenPromise = manager.requestNewToken();

      expect(mockPostMessage).toHaveBeenCalledWith(
        {
          type: "SESSION_TOKEN_REQUEST",
          requestId: "test-uuid-123",
          appId: "my-app",
        },
        "https://gateway.example.com",
      );

      // Complete the promise
      simulateTokenResponse({
        token: "new-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;
    });

    it("rejects when response contains error", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({ error: "Token request denied" });

      await expect(tokenPromise).rejects.toThrow("Token request denied");
    });

    it("rejects when response has no token", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Simulate response with no token field
      simulateTokenResponse({});

      await expect(tokenPromise).rejects.toThrow("No token in response");
    });

    it("times out after MESSAGE_TIMEOUT_MS", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Fast-forward past the timeout (5000ms)
      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("ignores messages from wrong origin (security-critical)", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Send message from wrong origin - this should be ignored
      simulateTokenResponse({
        token: "malicious-token",
        origin: "https://malicious.example.com",
      });

      // Should still timeout because the message was ignored
      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("ignores messages with wrong requestId (security-critical)", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Send message with wrong requestId - this should be ignored
      simulateTokenResponse({
        token: "wrong-token",
        requestId: "wrong-request-id",
      });

      // Should still timeout
      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("ignores messages with wrong type", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Send message with wrong type
      simulateTokenResponse({
        token: "wrong-token",
        type: "WRONG_MESSAGE_TYPE",
      });

      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("deduplicates concurrent token requests", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // Start two concurrent requests
      const promise1 = manager.requestNewToken();
      const promise2 = manager.requestNewToken();

      // Should only send one postMessage
      expect(mockPostMessage).toHaveBeenCalledTimes(1);

      // Complete the request
      simulateTokenResponse({
        token: "shared-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      // Both promises should resolve with the same token
      const [token1, token2] = await Promise.all([promise1, promise2]);

      expect(token1).toBe("shared-token");
      expect(token2).toBe("shared-token");
    });
  });

  describe("getToken", () => {
    it("requests new token when no token exists", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.getToken();

      simulateTokenResponse({
        token: "new-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      const token = await tokenPromise;

      expect(token).toBe("new-token");
      expect(mockPostMessage).toHaveBeenCalled();
    });

    it("returns cached token when not expiring soon", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // First, get a token
      const firstPromise = manager.getToken();

      simulateTokenResponse({
        token: "cached-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(), // 60 seconds, well above 10s buffer
      });

      await firstPromise;

      // Reset mock to check if second call makes new request
      mockPostMessage.mockClear();

      // Get token again - should use cache
      const cachedToken = await manager.getToken();

      expect(cachedToken).toBe("cached-token");
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it("requests new token when token is expiring soon", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // Get initial token that's about to expire
      const firstPromise = manager.getToken();

      simulateTokenResponse({
        token: "expiring-token",
        expiresAt: new Date(Date.now() + 5000).toISOString(), // 5 seconds, under 10s buffer
      });

      await firstPromise;

      mockPostMessage.mockClear();

      // Request new UUID for second request
      vi.stubGlobal("crypto", {
        randomUUID: () => "second-uuid-456",
      });

      // Get token again - should request new token since current is expiring soon
      const secondPromise = manager.getToken();

      expect(mockPostMessage).toHaveBeenCalled();

      simulateTokenResponse({
        token: "fresh-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        requestId: "second-uuid-456",
      });

      const newToken = await secondPromise;

      expect(newToken).toBe("fresh-token");
    });
  });

  describe("getUser", () => {
    it("returns null when no token exists", () => {
      const manager = new SessionManager({ appId: "test-app" });

      const user = manager.getUser();

      expect(user).toBeNull();
    });

    it("returns null for malformed JWT", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "not-a-valid-jwt",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toBeNull();
    });

    it("returns null for JWT with only two parts", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "header.payload", // Missing signature
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toBeNull();
    });

    it("returns null for JWT with invalid base64 payload", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Invalid base64 that will throw in atob()
      simulateTokenResponse({
        token: "header.!!!invalid-base64!!!.signature",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toBeNull();
    });

    it("returns null for JWT with missing sub claim", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // Create a JWT-like token with no sub claim
      const payload = btoa(JSON.stringify({ email: "test@example.com" }));
      const fakeToken = `header.${payload}.signature`;

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: fakeToken,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toBeNull();
    });

    it("extracts user info from valid JWT", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // Create a valid JWT-like token
      const payload = btoa(
        JSON.stringify({
          sub: "user-123",
          email: "test@example.com",
        }),
      );
      const fakeToken = `header.${payload}.signature`;

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: fakeToken,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toEqual({
        userId: "user-123",
        email: "test@example.com",
      });
    });

    it("handles missing email in JWT", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const payload = btoa(
        JSON.stringify({
          sub: "user-123",
          // No email field
        }),
      );
      const fakeToken = `header.${payload}.signature`;

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: fakeToken,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toEqual({
        userId: "user-123",
        email: "", // Defaults to empty string
      });
    });

    it("extracts user info from base64url-encoded JWT payload", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const fakeToken = createBase64UrlJwtLikeToken({
        sub: "user-123",
        email: "test@example.com",
      });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: fakeToken,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      const user = manager.getUser();

      expect(user).toEqual({
        userId: "user-123",
        email: "test@example.com",
      });
    });
  });

  describe("default token lifetime", () => {
    it("uses DEFAULT_TOKEN_LIFETIME_MS when expiresAt not provided", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Simulate response with no expiresAt field
      simulateTokenResponse({
        token: "token-without-expiry",
      });

      await tokenPromise;

      const state = manager.getTokenState();

      // Token should be valid (default lifetime is 60000ms)
      expect(state.status).toBe("VALID");
    });
  });

  describe("security edge cases", () => {
    it("cleans up event listener on successful response", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "valid-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await tokenPromise;

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    });

    it("cleans up event listener on timeout", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    });

    it("cleans up event listener on error response", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({ error: "Access denied" });

      await expect(tokenPromise).rejects.toThrow("Access denied");

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "message",
        expect.any(Function),
      );
    });

    it("ignores messages with null origin (sandboxed iframes, file:// URLs)", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Null origin occurs with sandboxed iframes and file:// URLs
      simulateMalformedMessage(null, {
        type: "SESSION_TOKEN_RESPONSE",
        requestId: "test-uuid-123",
        token: "suspicious-token",
      });

      // Should timeout because null origin doesn't match
      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("ignores messages with null event.data", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Send message with null data - should not crash
      simulateMalformedMessage("https://gateway.example.com", null);

      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("ignores messages with primitive event.data", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Send message with string data - should not crash
      simulateMalformedMessage("https://gateway.example.com", "not an object");

      // Send message with number data
      simulateMalformedMessage("https://gateway.example.com", 12345);

      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });

    it("ignores messages with undefined event.data", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      // Send message with undefined data - should not crash
      simulateMalformedMessage("https://gateway.example.com", undefined);

      vi.advanceTimersByTime(5001);

      await expect(tokenPromise).rejects.toThrow(
        "Token request timeout - parent did not respond",
      );
    });
  });

  describe("expiresAt handling", () => {
    it("uses default lifetime when expiresAt is invalid date string", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "token-with-invalid-expiry",
        expiresAt: "not-a-valid-date",
      });

      await tokenPromise;

      const state = manager.getTokenState();

      // Should be valid because it fell back to default lifetime (60s)
      expect(state.status).toBe("VALID");
      expect(state.token).toBe("token-with-invalid-expiry");
    });

    it("uses default lifetime when expiresAt is empty string", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      const tokenPromise = manager.requestNewToken();

      simulateTokenResponse({
        token: "token-with-empty-expiry",
        expiresAt: "",
      });

      await tokenPromise;

      const state = manager.getTokenState();

      // Empty string is falsy, so should use default lifetime
      expect(state.status).toBe("VALID");
    });
  });

  describe("concurrent request error handling", () => {
    it("propagates error to all waiting callers when request fails", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // Start three concurrent requests
      const promise1 = manager.requestNewToken();
      const promise2 = manager.requestNewToken();
      const promise3 = manager.requestNewToken();

      // Should only send one postMessage (deduplication)
      expect(mockPostMessage).toHaveBeenCalledTimes(1);

      // Simulate error response
      simulateTokenResponse({ error: "Authentication failed" });

      // All three promises should reject with the same error
      await expect(promise1).rejects.toThrow("Authentication failed");
      await expect(promise2).rejects.toThrow("Authentication failed");
      await expect(promise3).rejects.toThrow("Authentication failed");
    });

    it("allows new request after previous request failed", async () => {
      const manager = new SessionManager({ appId: "test-app" });

      // First request fails
      const failedPromise = manager.requestNewToken();
      simulateTokenResponse({ error: "Temporary failure" });
      await expect(failedPromise).rejects.toThrow("Temporary failure");

      // Reset mock and UUID for second request
      mockPostMessage.mockClear();
      vi.stubGlobal("crypto", {
        randomUUID: () => "second-uuid-456",
      });

      // Second request should work
      const successPromise = manager.requestNewToken();

      expect(mockPostMessage).toHaveBeenCalledTimes(1);

      simulateTokenResponse({
        token: "success-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        requestId: "second-uuid-456",
      });

      const token = await successPromise;
      expect(token).toBe("success-token");
    });
  });

  describe("react-native-webview token push", () => {
    beforeEach(() => {
      messageHandler = null;
      addEventListenerSpy = vi.fn((event: string, handler: Function) => {
        if (event === "message") {
          messageHandler = handler as (event: MessageEvent) => void;
        }
      });

      vi.stubGlobal("window", {
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
        ReactNativeWebView: {
          postMessage: vi.fn(),
        },
        parent: {
          postMessage: mockPostMessage,
        },
      });
    });

    it("accepts pushed token only when appId and audience match", async () => {
      const manager = new SessionManager({ appId: "todo-app" });
      const tokenPromise = manager.requestNewToken();

      const token = createJwtLikeToken({
        sub: "user-1",
        aud: "todo-app",
      });

      simulateMalformedMessage("react-native", {
        type: "SESSION_TOKEN_UPDATE",
        appId: "todo-app",
        token,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      await expect(tokenPromise).resolves.toBe(token);
    });

    it("accepts stringified token update payload with null-like origin", async () => {
      const manager = new SessionManager({ appId: "todo-app" });
      const tokenPromise = manager.requestNewToken();

      const token = createJwtLikeToken({
        sub: "user-1",
        aud: "todo-app",
      });

      simulateMalformedMessage(
        "null",
        JSON.stringify({
          type: "SESSION_TOKEN_UPDATE",
          appId: "todo-app",
          token,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      );

      await expect(tokenPromise).resolves.toBe(token);
    });

    it("ignores malformed JSON token updates", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "todo-app" });
      const tokenPromise = manager.requestNewToken();

      simulateMalformedMessage("react-native", "{not-json");

      vi.advanceTimersByTime(10001);

      await expect(tokenPromise).rejects.toThrow(
        "Timed out waiting for token from React Native bridge",
      );
    });

    it("rejects pushed token when audience does not match expected app", async () => {
      vi.useFakeTimers();

      const manager = new SessionManager({ appId: "todo-app" });
      const tokenPromise = manager.requestNewToken();

      const wrongAudienceToken = createJwtLikeToken({
        sub: "user-1",
        aud: "chef-app",
      });

      simulateMalformedMessage("react-native", {
        type: "SESSION_TOKEN_UPDATE",
        appId: "todo-app",
        token: wrongAudienceToken,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });

      vi.advanceTimersByTime(10001);

      await expect(tokenPromise).rejects.toThrow(
        "Timed out waiting for token from React Native bridge",
      );
    });
  });
});
