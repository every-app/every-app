import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Cloudflare worker dependencies before importing the module under test
vi.mock("@/serverFunctions/session-token", () => ({
  createSessionToken: vi.fn(),
}));

import {
  validateTokenRequest,
  handleSessionTokenRequest,
  type AppConfig,
} from "./session-token-handler";
import { createSessionToken } from "@/serverFunctions/session-token";

const mockCreateSessionToken = vi.mocked(createSessionToken);

const mockUserApps: AppConfig[] = [
  {
    appId: "todo-app",
    appUrl: "https://todo.example.com",
    devUrl: "http://localhost:3001",
  },
  {
    appId: "workout-tracker",
    appUrl: "https://workout.example.com",
    devUrl: "http://localhost:3002",
  },
];

function createValidRequest(appId: string) {
  return {
    type: "SESSION_TOKEN_REQUEST",
    requestId: "test-request-123",
    appId,
  };
}

describe("validateTokenRequest", () => {
  describe("valid requests", () => {
    it("accepts request from matching production origin", () => {
      const result = validateTokenRequest(
        "https://todo.example.com",
        createValidRequest("todo-app"),
        mockUserApps,
      );

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.appId).toBe("todo-app");
        expect(result.requestId).toBe("test-request-123");
      }
    });

    it("accepts request from matching dev origin", () => {
      const result = validateTokenRequest(
        "http://localhost:3001",
        createValidRequest("todo-app"),
        mockUserApps,
      );

      expect(result.valid).toBe(true);
    });
  });

  describe("schema validation", () => {
    it("rejects malformed messages", () => {
      const invalidMessages = [
        { requestId: "123", appId: "todo-app" }, // missing type
        { type: "WRONG_TYPE", requestId: "123", appId: "todo-app" }, // wrong type
        { type: "SESSION_TOKEN_REQUEST", appId: "todo-app" }, // missing requestId
        "not an object",
        null,
      ];

      for (const data of invalidMessages) {
        const result = validateTokenRequest(
          "https://todo.example.com",
          data,
          mockUserApps,
        );
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe("invalid_schema");
        }
      }
    });
  });

  describe("appId validation", () => {
    it("rejects request with missing or empty appId", () => {
      const missingAppId = { type: "SESSION_TOKEN_REQUEST", requestId: "123" };
      const emptyAppId = {
        type: "SESSION_TOKEN_REQUEST",
        requestId: "123",
        appId: "",
      };

      for (const data of [missingAppId, emptyAppId]) {
        const result = validateTokenRequest(
          "https://todo.example.com",
          data,
          mockUserApps,
        );
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe("missing_app_id");
        }
      }
    });

    it("rejects request for app not in user's installed apps", () => {
      const result = validateTokenRequest(
        "https://unknown.example.com",
        createValidRequest("unknown-app"),
        mockUserApps,
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("unknown_app");
      }
    });
  });

  describe("origin validation (security-critical)", () => {
    it("rejects request from non-matching origin", () => {
      const result = validateTokenRequest(
        "https://malicious.com",
        createValidRequest("todo-app"),
        mockUserApps,
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("origin_mismatch");
      }
    });

    it("rejects origin with wrong port", () => {
      const result = validateTokenRequest(
        "http://localhost:9999",
        createValidRequest("todo-app"),
        mockUserApps,
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("origin_mismatch");
      }
    });

    it("rejects cross-app token request (app A origin requesting app B token)", () => {
      // This is the key security test: todo-app's origin cannot request
      // a token for workout-tracker, even though both are valid apps
      const result = validateTokenRequest(
        "https://todo.example.com",
        createValidRequest("workout-tracker"),
        mockUserApps,
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("origin_mismatch");
      }
    });
  });

  describe("edge cases", () => {
    it("handles appUrl with trailing slash or path", () => {
      const appsWithPath: AppConfig[] = [
        {
          appId: "path-app",
          appUrl: "https://example.com/app/",
          devUrl: null,
        },
      ];

      // URL.origin ignores path and trailing slash
      const result = validateTokenRequest(
        "https://example.com",
        createValidRequest("path-app"),
        appsWithPath,
      );

      expect(result.valid).toBe(true);
    });
  });
});

describe("handleSessionTokenRequest", () => {
  function createMockEvent(origin: string, data: unknown): MessageEvent {
    return { origin, data } as MessageEvent;
  }

  // Full UserAccessApp objects for handleSessionTokenRequest tests
  const mockFullUserApps = [
    {
      id: "1",
      organizationId: "org-123",
      appId: "todo-app",
      name: "Todo App",
      description: "A todo app",
      appUrl: "https://todo.example.com",
      devUrl: "http://localhost:3001",
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      grantedAt: new Date(),
    },
    {
      id: "2",
      organizationId: "org-123",
      appId: "workout-tracker",
      name: "Workout Tracker",
      description: "A workout tracker",
      appUrl: "https://workout.example.com",
      devUrl: "http://localhost:3002",
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      grantedAt: new Date(),
    },
  ];

  beforeEach(() => {
    mockCreateSessionToken.mockReset();
  });

  it("calls createSessionToken only after validation passes", async () => {
    mockCreateSessionToken.mockResolvedValue({
      token: "mock-token",
      expiresAt: "2024-01-01T00:00:00Z",
      audience: "todo-app",
      appId: "todo-app",
      orgId: "org-test-123",
    });

    const event = createMockEvent(
      "https://todo.example.com",
      createValidRequest("todo-app"),
    );

    const result = await handleSessionTokenRequest(event, mockFullUserApps);

    expect(mockCreateSessionToken).toHaveBeenCalledOnce();
    expect(result?.token).toBe("mock-token");
  });

  it("does not call createSessionToken when validation fails", async () => {
    // Cross-app attack: todo-app origin requesting workout-tracker token
    const event = createMockEvent(
      "https://todo.example.com",
      createValidRequest("workout-tracker"),
    );

    const result = await handleSessionTokenRequest(event, mockFullUserApps);

    expect(mockCreateSessionToken).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("does not call createSessionToken for malicious origin", async () => {
    const event = createMockEvent(
      "https://malicious.com",
      createValidRequest("todo-app"),
    );

    const result = await handleSessionTokenRequest(event, mockFullUserApps);

    expect(mockCreateSessionToken).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
