import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHasAnyOwnerMembership = vi.fn();
const mockClaimOwnerBootstrap = vi.fn();
const mockReleaseOwnerBootstrap = vi.fn();
const mockGrantDefaultAppsToUser = vi.fn();

const mockMembersFindFirst = vi.fn();
const mockInvitationsFindFirst = vi.fn();
const mockInvitationsFindMany = vi.fn();
const mockDeleteWhere = vi.fn();
const mockSelectWhere = vi.fn();

const mockSignUpEmail = vi.fn();
const mockCreateOrganization = vi.fn();
const mockRemoveUser = vi.fn();
const mockRequestPasswordReset = vi.fn();
const mockCancelInvitation = vi.fn();
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
        findFirst: (...args: unknown[]) => mockInvitationsFindFirst(...args),
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
    id: "id",
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
      cancelInvitation: (...args: unknown[]) => mockCancelInvitation(...args),
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
  claimOwnerBootstrap: (...args: unknown[]) => mockClaimOwnerBootstrap(...args),
  releaseOwnerBootstrap: (...args: unknown[]) =>
    mockReleaseOwnerBootstrap(...args),
}));

vi.mock("../repositories/UserRepository", () => ({
  UserRepository: {
    findById: vi.fn(),
  },
}));

import { UserRepository } from "../repositories/UserRepository";
import { AdminService } from "./AdminService";

const mockUserRepository = vi.mocked(UserRepository);
const orgContext = {
  orgId: "org-1",
  userId: "current-user",
  role: "owner",
} as const;

describe("AdminService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembersFindFirst.mockResolvedValue({ id: "member-1", role: "member" });
    mockInvitationsFindFirst.mockResolvedValue(null);
    mockInvitationsFindMany.mockResolvedValue([]);
    mockDeleteWhere.mockResolvedValue(undefined);
    mockSelectWhere.mockResolvedValue([{ value: 1 }]);
    mockSignUpEmail.mockResolvedValue({
      user: { id: "user-1", email: "owner@example.com", name: "Owner" },
    });
    mockCreateOrganization.mockResolvedValue({ id: "org-1" });
    mockClaimOwnerBootstrap.mockResolvedValue(true);
    mockReleaseOwnerBootstrap.mockResolvedValue(undefined);
    mockGrantDefaultAppsToUser.mockResolvedValue(undefined);
    mockRemoveUser.mockResolvedValue(undefined);
    mockListMembersForOrganization.mockResolvedValue([]);
    mockRequestPasswordReset.mockResolvedValue(undefined);
    mockCancelInvitation.mockResolvedValue({
      id: "invite-1",
      status: "canceled",
    });
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

  it("allows only one owner initialization when both requests observe no owner", async () => {
    mockHasAnyOwnerMembership.mockResolvedValue(false);
    mockClaimOwnerBootstrap
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const results = await Promise.allSettled([
      AdminService.initializeOwner("first@example.com", "password123"),
      AdminService.initializeOwner("second@example.com", "password123"),
    ]);

    expect(results[0]).toEqual({
      status: "fulfilled",
      value: { userId: "user-1", organizationId: "org-1" },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: new Error("Owner already exists. Registration is invite-only."),
    });
    expect(mockSignUpEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateOrganization).toHaveBeenCalledTimes(1);
    expect(mockGrantDefaultAppsToUser).toHaveBeenCalledTimes(1);
  });

  it("releases the bootstrap claim after a failed initialization", async () => {
    mockHasAnyOwnerMembership.mockResolvedValue(false);
    mockCreateOrganization.mockRejectedValue(new Error("organization failed"));

    await expect(
      AdminService.initializeOwner("owner@example.com", "password123"),
    ).rejects.toThrow("organization failed");

    expect(mockRemoveUser).toHaveBeenCalledWith({
      body: { userId: "user-1" },
    });
    expect(mockReleaseOwnerBootstrap).toHaveBeenCalledOnce();
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

    const result = await AdminService.listMembers(orgContext);

    expect(result.users).toHaveLength(2);
    expect(result.users[0]?.id).toBe("invitation:invite-1");
    expect(result.users[0]?.invitationId).toBe("invite-1");
    expect(result.users[1]?.id).toBe("user-1");
  });

  it("cancels a pending invitation scoped to the active organization", async () => {
    const headers = new Headers({ cookie: "session=test" });
    mockInvitationsFindFirst.mockResolvedValue({ id: "invite-1" });

    await expect(
      AdminService.cancelInvitation(orgContext, "invite-1", headers),
    ).resolves.toEqual({ success: true });

    expect(mockInvitationsFindFirst).toHaveBeenCalledWith({
      columns: { id: true },
      where: {
        and: [
          { col: "id", val: "invite-1" },
          { col: "organizationId", val: "org-1" },
          { col: "status", val: "pending" },
        ],
      },
    });
    expect(mockCancelInvitation).toHaveBeenCalledWith({
      headers,
      body: { invitationId: "invite-1" },
    });
  });

  it("does not cancel an invitation outside the active organization", async () => {
    const headers = new Headers();
    mockInvitationsFindFirst.mockResolvedValue(null);

    await expect(
      AdminService.cancelInvitation(orgContext, "other-org-invite", headers),
    ).rejects.toThrow("Pending invitation not found");

    expect(mockCancelInvitation).not.toHaveBeenCalled();
  });

  it("prevents the acting user from deleting themselves", async () => {
    await expect(
      AdminService.deleteUser(orgContext, "current-user"),
    ).rejects.toThrow("Cannot delete your own account");
  });

  it("sends password reset email for active user", async () => {
    mockMembersFindFirst.mockResolvedValue({ id: "member-1" });
    mockUserRepository.findById.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      status: "active",
    } as any);

    await AdminService.sendPasswordResetEmail(orgContext, "user-1");

    expect(mockRequestPasswordReset).toHaveBeenCalledWith({
      body: {
        email: "user@example.com",
        redirectTo: "https://gateway.example.com/reset-password",
      },
    });
  });

  it("rejects password reset email for non-active user", async () => {
    mockMembersFindFirst.mockResolvedValue({ id: "member-1" });
    mockUserRepository.findById.mockResolvedValue({
      id: "user-2",
      email: "pending@example.com",
      status: "pending",
    } as any);

    await expect(
      AdminService.sendPasswordResetEmail(orgContext, "user-2"),
    ).rejects.toThrow("Can only send password reset emails for active users");
  });
});
