import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  getGatewayUrl: vi.fn(),
}));

vi.mock("@/src/lib/auth-client", () => ({
  authClient: { getCookie: mocks.getCookie },
  getGatewayUrl: mocks.getGatewayUrl,
}));

import { fetchUserApps, userAppsResponseSchema } from "./gateway";

describe("fetchUserApps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the stored session cookie to the gateway", async () => {
    // @better-auth/expo reads the cookie from SecureStore asynchronously.
    mocks.getCookie.mockResolvedValue("better-auth.session_token=abc");
    mocks.getGatewayUrl.mockReturnValue("https://example.com");
    const fetchMock = vi.fn(async () => Response.json({ apps: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUserApps()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/api/me/apps", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: "better-auth.session_token=abc",
      },
    });
  });
});

describe("userAppsResponseSchema", () => {
  it("accepts string and numeric timestamps and tolerates extra fields", () => {
    const result = userAppsResponseSchema.parse({
      apps: [
        {
          id: "row-1",
          organizationId: "org-1",
          appId: "todo",
          name: "Todo",
          description: "Keep track of tasks",
          hostname: "todo.example.com",
          status: "active",
          isDefault: true,
          createdAt: "2026-07-15T12:00:00.000Z",
          updatedAt: "2026-07-15T12:30:00.000Z",
          grantedAt: "2026-07-15T12:45:00.000Z",
          futureField: "ignored",
        },
        {
          id: "row-2",
          organizationId: "org-1",
          appId: "notes",
          name: "Notes",
          description: "Write things down",
          hostname: "notes.example.com",
          status: "deploying",
          isDefault: false,
          createdAt: 1_752_580_800_000,
          updatedAt: 1_752_582_600_000,
          grantedAt: 1_752_583_500_000,
        },
      ],
      responseVersion: 2,
    });

    expect(result.apps).toHaveLength(2);
    expect(result.apps[0]).not.toHaveProperty("futureField");
    expect(result).not.toHaveProperty("responseVersion");
  });
});
