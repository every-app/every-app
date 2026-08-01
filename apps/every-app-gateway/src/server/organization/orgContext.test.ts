import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindFirst, mockFindMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...parts: unknown[]) => ({ type: "and", parts })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: "eq", left, right })),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      members: {
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
    },
  },
}));

vi.mock("@/db/schema", () => ({
  members: {
    userId: "members.user_id",
    organizationId: "members.organization_id",
  },
}));

import { clearOrgContextCacheForTests, resolveOrgContext } from "./orgContext";

describe("resolveOrgContext", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearOrgContextCacheForTests();
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
  });

  it("uses a cached membership on the second lookup", async () => {
    mockFindFirst.mockResolvedValue({
      organizationId: "org-1",
      role: "member",
    });

    const input = {
      userId: "user-1",
      activeOrganizationId: "org-1",
    };
    await resolveOrgContext(input);
    await resolveOrgContext(input);

    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it("refetches membership after the cache TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockFindFirst.mockResolvedValue({
      organizationId: "org-1",
      role: "member",
    });

    const input = {
      userId: "user-1",
      activeOrganizationId: "org-1",
    };
    await resolveOrgContext(input);
    vi.setSystemTime(30_001);
    await resolveOrgContext(input);

    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  it("caches null membership results", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const input = {
      userId: "user-1",
      activeOrganizationId: "org-2",
    };
    await expect(resolveOrgContext(input)).resolves.toBeNull();
    await expect(resolveOrgContext(input)).resolves.toBeNull();

    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it("resolves a verified active organization membership", async () => {
    mockFindFirst.mockResolvedValue({
      organizationId: "org-1",
      role: "member,admin",
    });

    await expect(
      resolveOrgContext({
        userId: "user-1",
        activeOrganizationId: "org-1",
      }),
    ).resolves.toEqual({
      orgId: "org-1",
      userId: "user-1",
      role: "admin",
    });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("rejects an active organization the user is not a member of", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    await expect(
      resolveOrgContext({
        userId: "user-1",
        activeOrganizationId: "org-2",
      }),
    ).resolves.toBeNull();
  });

  it("uses the sole-membership fallback", async () => {
    mockFindMany.mockResolvedValue([
      { organizationId: "org-1", role: "owner" },
    ]);

    await expect(
      resolveOrgContext({
        userId: "user-1",
        activeOrganizationId: null,
      }),
    ).resolves.toEqual({
      orgId: "org-1",
      userId: "user-1",
      role: "owner",
    });
  });

  it("fails closed when the user belongs to multiple organizations", async () => {
    mockFindMany.mockResolvedValue([
      { organizationId: "org-1", role: "member" },
      { organizationId: "org-2", role: "member" },
    ]);

    await expect(
      resolveOrgContext({
        userId: "user-1",
        activeOrganizationId: null,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed with zero memberships or an unknown role", async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ organizationId: "org-1", role: "billing" }]);

    await expect(
      resolveOrgContext({
        userId: "user-1",
        activeOrganizationId: null,
      }),
    ).resolves.toBeNull();
    clearOrgContextCacheForTests();
    await expect(
      resolveOrgContext({
        userId: "user-1",
        activeOrganizationId: null,
      }),
    ).resolves.toBeNull();
  });
});
