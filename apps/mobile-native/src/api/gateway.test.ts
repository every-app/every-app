import { describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/auth-client", () => ({
  authClient: { getCookie: vi.fn() },
  getGatewayUrl: vi.fn(),
}));

import { userAppsResponseSchema } from "./gateway";

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
