import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHasAnyOwnerMembership = vi.fn();

const mockMembersFindFirst = vi.fn();
const mockInvitationsFindFirst = vi.fn();
const mockInvitationsFindMany = vi.fn();
const mockDeleteWhere = vi.fn();
const mockSelectWhere = vi.fn();

const mockCancelInvitation = vi.fn();
const mockListMembersForOrganization = vi.fn();

vi.mock("@/server/access-rejoin", () => ({
  accessWouldLetBackIn: () => false,
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
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
      cancelInvitation: (...args: unknown[]) => mockCancelInvitation(...args),
    },
  }),
}));

// The member-management rule itself is pinned by user-management.sqlite.test.ts;
// here only its first check (never yourself) matters, before any read.
vi.mock("./MembershipService", () => ({
  MembershipService: {
    requireManageableMember: async (
      ctx: { userId: string },
      targetUserId: string,
    ) => {
      if (targetUserId === ctx.userId) {
        throw Object.assign(new Error("You cannot deactivate yourself"), {
          code: "CANNOT_MANAGE_SELF",
        });
      }
      return { role: "member" };
    },
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
    mockUserRepository.findById.mockResolvedValue({
      id: "user-1",
      email: "owner@example.com",
      status: "active",
    } as any);
    mockListMembersForOrganization.mockResolvedValue([]);
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
    ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
  });
});
