import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/repositories/OrganizationMembersRepository", () => ({
  OrganizationMembersRepository: {
    listMembersForOrganization: vi.fn(),
  },
}));

import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { Route } from "./users";

const mockOrganizationMembersRepository = vi.mocked(
  OrganizationMembersRepository,
);

function getHandler() {
  return (Route as any).options.server.handlers.GET as (context: {
    request: Request;
  }) => Promise<Response>;
}

describe("/api/internal/apps/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when organizationId query param is missing", async () => {
    const response = await getHandler()({
      request: new Request(
        "https://gateway.example.com/api/internal/apps/users",
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Expected string, received null",
    });
    expect(
      mockOrganizationMembersRepository.listMembersForOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns org-scoped users when organizationId is provided", async () => {
    mockOrganizationMembersRepository.listMembersForOrganization.mockResolvedValue(
      [
        {
          id: "user-1",
          name: "Alex",
          email: "alex@example.com",
          role: "owner",
          status: "active",
          createdAt: new Date("2026-01-01"),
          banned: false,
        },
      ] as any,
    );

    const response = await getHandler()({
      request: new Request(
        "https://gateway.example.com/api/internal/apps/users?organizationId=org-123",
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      users: [
        {
          id: "user-1",
          name: "Alex",
          email: "alex@example.com",
        },
      ],
    });

    expect(
      mockOrganizationMembersRepository.listMembersForOrganization,
    ).toHaveBeenCalledWith("org-123");
  });
});
