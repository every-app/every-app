import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHasAnyOwnerMembership = vi.fn();
const mockGrantDefaultAppsToUser = vi.fn();

const mockMembersFindFirst = vi.fn();
const mockInvitationsFindMany = vi.fn();
const mockDeleteWhere = vi.fn();
const mockSelectWhere = vi.fn();

const mockSignUpEmail = vi.fn();
const mockCreateOrganization = vi.fn();
const mockRemoveUser = vi.fn();
const mockRequestPasswordReset = vi.fn();
const mockListMembersForOrganization = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_URL: "https://gateway.example.com",
  },
}));

vi.mock("@/db", () => ({
  db: {
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    query: {
      members: {
        findFirst: (...args: unknown[]) => mockMembersFindFirst(...args),
      },
      invitations: {
        findMany: (...args: unknown[]) => mockInvitationsFindMany(...args),
      },
    },
    select: vi.fn(() => ({
      from: () => ({
        where: (...args: unknown[]) => mockSelectWhere(...args),
      }),
    })),
  },
}));

vi.mock("@/db/schema", () => ({
  invitations: {
    organizationId: "organizationId",
    status: "status",
  },
  members: {
    userId: "userId",
    organizationId: "organizationId",
    role: "role",
  },
  users: {
    id: "id",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ col, val }),
  count: () => "count",
}));

vi.mock("@/auth", () => ({
  createAuth: () => ({
    api: {
      signUpEmail: (...args: unknown[]) => mockSignUpEmail(...args),
      createOrganization: (...args: unknown[]) =>
        mockCreateOrganization(...args),
      removeUser: (...args: unknown[]) => mockRemoveUser(...args),
      requestPasswordReset: (...args: unknown[]) =>
        mockRequestPasswordReset(...args),
    },
  }),
}));

vi.mock("./AppAccessService", () => ({
  AppAccessService: {
    grantDefaultAppsToUser: (...args: unknown[]) =>
      mockGrantDefaultAppsToUser(...args),
  },
}));

vi.mock("../repositories/OrganizationMembersRepository", () => ({
  OrganizationMembersRepository: {
    listMembersForOrganization: (...args: unknown[]) =>
      mockListMembersForOrganization(...args),
  },
}));

vi.mock("@/server/organization/owner-membership", () => ({
  hasAnyOwnerMembership: (...args: unknown[]) =>
    mockHasAnyOwnerMembership(...args),
}));

vi.mock("../repositories/UserRepository", () => ({
  UserRepository: {
    findById: vi.fn(),
  },
}));

import { UserRepository } from "../repositories/UserRepository";
import { AdminService } from "./AdminService";

const mockUserRepository = vi.mocked(UserRepository);

describe("AdminService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembersFindFirst.mockResolvedValue({ id: "member-1", role: "member" });
    mockInvitationsFindMany.mockResolvedValue([]);
    mockDeleteWhere.mockResolvedValue(undefined);
    mockSelectWhere.mockResolvedValue([{ value: 1 }]);
    mockSignUpEmail.mockResolvedValue({
      user: { id: "user-1", email: "owner@example.com", name: "Owner" },
    });
    mockCreateOrganization.mockResolvedValue({ id: "org-1" });
    mockGrantDefaultAppsToUser.mockResolvedValue(undefined);
    mockRemoveUser.mockResolvedValue(undefined);
    mockListMembersForOrganization.mockResolvedValue([]);
    mockRequestPasswordReset.mockResolvedValue(undefined);
  });

  it("returns hasOwner status when owner exists", async () => {
    mockHasAnyOwnerMembership.mockResolvedValue(true);

    await expect(AdminService.hasOwner()).resolves.toEqual({ hasOwner: true });
  });

  it("returns hasOwner false when no owner exists", async () => {
    mockHasAnyOwnerMembership.mockResolvedValue(false);

    await expect(AdminService.hasOwner()).resolves.toEqual({ hasOwner: false });
  });

  it("rejects owner initialization when owner already exists", async () => {
    mockHasAnyOwnerMembership.mockResolvedValue(true);

    await expect(
      AdminService.initializeOwner("owner@example.com", "password123"),
    ).rejects.toThrow("Owner already exists. Registration is invite-only.");
  });

  it("creates first owner successfully when no owner exists", async () => {
    mockHasAnyOwnerMembership.mockResolvedValue(false);

    const result = await AdminService.initializeOwner(
      "owner@example.com",
      "password123",
    );

    expect(result).toEqual({ userId: "user-1", organizationId: "org-1" });
    expect(mockGrantDefaultAppsToUser).toHaveBeenCalledWith("user-1", "org-1");
  });

  it("lists active members and pending invitations", async () => {
    mockListMembersForOrganization.mockResolvedValue([
      {
        id: "user-1",
        name: "Alice",
        email: "alice@example.com",
        role: "member",
        status: "active",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        banned: false,
      },
    ]);
    mockInvitationsFindMany.mockResolvedValue([
      {
        id: "invite-1",
        email: "bob@example.com",
        role: "member",
        status: "pending",
        createdAt: new Date("2025-01-02T00:00:00.000Z"),
      },
    ]);

    const result = await AdminService.listMembers("org-1");

    expect(result.users).toHaveLength(2);
    expect(result.users[0]?.id).toBe("invitation:invite-1");
    expect(result.users[1]?.id).toBe("user-1");
  });

  it("requires organization context for deleteUser", async () => {
    await expect(
      AdminService.deleteUser(
        "target-user",
        "current-user",
        undefined,
      ),
    ).rejects.toThrow("Organization context is required");
  });

  it("sends password reset email for active user", async () => {
    mockMembersFindFirst.mockResolvedValue({ id: "member-1" });
    mockUserRepository.findById.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      status: "active",
    } as any);

    await AdminService.sendPasswordResetEmail("user-1", "org-1");

    expect(mockRequestPasswordReset).toHaveBeenCalledWith({
      body: {
        email: "user@example.com",
        redirectTo: "https://gateway.example.com/reset-password",
      },
    });
  });

  it("requires organization context when sending password reset", async () => {
    await expect(
      AdminService.sendPasswordResetEmail("user-1", ""),
    ).rejects.toThrow("Organization context is required");
  });

  it("rejects password reset email for non-active user", async () => {
    mockMembersFindFirst.mockResolvedValue({ id: "member-1" });
    mockUserRepository.findById.mockResolvedValue({
      id: "user-2",
      email: "pending@example.com",
      status: "pending",
    } as any);

    await expect(
      AdminService.sendPasswordResetEmail("user-2", "org-1"),
    ).rejects.toThrow("Can only send password reset emails for active users");
  });
});
