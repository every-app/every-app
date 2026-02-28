import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must define mocks at the top level before using vi.mock
vi.mock("../repositories/TokenVerificationRepository", () => ({
  TokenVerificationRepository: {
    findByToken: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteByIdentifier: vi.fn(),
  },
}));

vi.mock("../repositories/UserRepository", () => ({
  UserRepository: {
    findOwner: vi.fn(),
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findAllForList: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../repositories/AccountRepository", () => ({
  AccountRepository: {
    updatePassword: vi.fn(),
  },
}));

vi.mock("../repositories/SessionRepository", () => ({
  SessionRepository: {
    deleteByUserId: vi.fn(),
  },
}));

vi.mock("./AppAccessService", () => ({
  AppAccessService: {
    grantDefaultAppsToUser: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockSignUpEmail = vi.fn();
vi.mock("@/auth", () => ({
  createAuth: () => ({
    api: {
      signUpEmail: mockSignUpEmail,
    },
  }),
}));

vi.mock("better-auth/crypto", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_URL: "https://gateway.example.com",
  },
}));

// Import after mocks are set up
import { AdminService } from "./AdminService";
import { TokenVerificationRepository } from "../repositories/TokenVerificationRepository";
import { UserRepository } from "../repositories/UserRepository";
import { AccountRepository } from "../repositories/AccountRepository";
import { SessionRepository } from "../repositories/SessionRepository";

// Get typed mocks
const mockTokenVerificationRepository = vi.mocked(TokenVerificationRepository);
const mockUserRepository = vi.mocked(UserRepository);
const mockAccountRepository = vi.mocked(AccountRepository);
const mockSessionRepository = vi.mocked(SessionRepository);

describe("AdminService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset crypto.randomUUID mock
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "test-uuid-1234-5678-9abc-def012345678" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validateToken (via acceptInvitation and resetPassword)", () => {
    describe("acceptInvitation - token validation", () => {
      it("throws error for invalid token", async () => {
        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          undefined,
        );

        await expect(
          AdminService.acceptInvitation("invalid-token", "new-password"),
        ).rejects.toThrow("Invalid or expired invitation token");
      });

      it("throws error and deletes expired token", async () => {
        const expiredVerification = {
          id: "verification-123",
          identifier: "user@example.com",
          value: "expired-token",
          expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          expiredVerification,
        );

        await expect(
          AdminService.acceptInvitation("expired-token", "new-password"),
        ).rejects.toThrow(
          "Invitation link has expired. Please request a new one.",
        );

        expect(mockTokenVerificationRepository.delete).toHaveBeenCalledWith(
          "verification-123",
        );
      });

      it("throws error if user not found after valid token", async () => {
        const validVerification = {
          id: "verification-123",
          identifier: "user@example.com",
          value: "valid-token",
          expiresAt: new Date(Date.now() + 86400000), // Valid for 1 day
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          validVerification,
        );
        mockUserRepository.findByEmail.mockResolvedValue(undefined);

        await expect(
          AdminService.acceptInvitation("valid-token", "new-password"),
        ).rejects.toThrow("User not found");
      });

      it("successfully accepts invitation with valid token", async () => {
        const validVerification = {
          id: "verification-123",
          identifier: "user@example.com",
          value: "valid-token",
          expiresAt: new Date(Date.now() + 86400000),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const user = {
          id: "user-123",
          email: "user@example.com",
          status: "pending",
        };

        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          validVerification,
        );
        mockUserRepository.findByEmail.mockResolvedValue(user as any);
        mockAccountRepository.updatePassword.mockResolvedValue(undefined);
        mockUserRepository.update.mockResolvedValue(undefined);
        mockTokenVerificationRepository.delete.mockResolvedValue(undefined);

        await expect(
          AdminService.acceptInvitation("valid-token", "new-password"),
        ).resolves.toEqual({ email: "user@example.com" });

        // Verify password was updated for the correct user
        expect(mockAccountRepository.updatePassword).toHaveBeenCalledTimes(1);
        expect(mockAccountRepository.updatePassword.mock.calls[0][0]).toBe(
          "user-123",
        );

        expect(mockUserRepository.update).toHaveBeenCalledWith("user-123", {
          status: "active",
        });
        expect(mockTokenVerificationRepository.delete).toHaveBeenCalledWith(
          "verification-123",
        );
      });
    });

    describe("resetPassword - token validation", () => {
      it("throws error for invalid reset token", async () => {
        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          undefined,
        );

        await expect(
          AdminService.resetPassword("invalid-token", "new-password"),
        ).rejects.toThrow("Invalid or expired reset token");
      });

      it("throws error and deletes expired reset token", async () => {
        const expiredVerification = {
          id: "verification-123",
          identifier: "user@example.com",
          value: "expired-token",
          expiresAt: new Date(Date.now() - 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          expiredVerification,
        );

        await expect(
          AdminService.resetPassword("expired-token", "new-password"),
        ).rejects.toThrow("Reset link has expired. Please request a new one.");

        expect(mockTokenVerificationRepository.delete).toHaveBeenCalledWith(
          "verification-123",
        );
      });

      it("throws error if user is not active", async () => {
        const validVerification = {
          id: "verification-123",
          identifier: "user@example.com",
          value: "valid-token",
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const pendingUser = {
          id: "user-123",
          email: "user@example.com",
          status: "pending",
        };

        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          validVerification,
        );
        mockUserRepository.findByEmail.mockResolvedValue(pendingUser as any);

        await expect(
          AdminService.resetPassword("valid-token", "new-password"),
        ).rejects.toThrow(
          "Password reset is only available for active users. Please use the invitation link instead.",
        );
      });

      it("successfully resets password and revokes all sessions", async () => {
        const validVerification = {
          id: "verification-123",
          identifier: "user@example.com",
          value: "valid-token",
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const activeUser = {
          id: "user-123",
          email: "user@example.com",
          status: "active",
        };

        mockTokenVerificationRepository.findByToken.mockResolvedValue(
          validVerification,
        );
        mockUserRepository.findByEmail.mockResolvedValue(activeUser as any);
        mockAccountRepository.updatePassword.mockResolvedValue(undefined);
        mockSessionRepository.deleteByUserId.mockResolvedValue(undefined);
        mockTokenVerificationRepository.delete.mockResolvedValue(undefined);

        await expect(
          AdminService.resetPassword("valid-token", "new-password"),
        ).resolves.toBeUndefined();

        // Verify password was updated for the correct user
        expect(mockAccountRepository.updatePassword).toHaveBeenCalledTimes(1);
        expect(mockAccountRepository.updatePassword.mock.calls[0][0]).toBe(
          "user-123",
        );

        // Critical security check: all sessions should be revoked
        expect(mockSessionRepository.deleteByUserId).toHaveBeenCalledWith(
          "user-123",
        );

        // Token should be deleted after use
        expect(mockTokenVerificationRepository.delete).toHaveBeenCalledWith(
          "verification-123",
        );
      });
    });
  });

  describe("initializeOwner", () => {
    it("throws error if owner already exists", async () => {
      mockUserRepository.findOwner.mockResolvedValue({
        id: "existing-owner",
        role: "owner",
      } as NonNullable<
        Awaited<ReturnType<typeof mockUserRepository.findOwner>>
      >);

      await expect(
        AdminService.initializeOwner("new@example.com", "password"),
      ).rejects.toThrow("Owner already exists. Registration is invite-only.");
    });

    it("creates owner with correct role and status", async () => {
      mockUserRepository.findOwner.mockResolvedValue(undefined);
      mockSignUpEmail.mockResolvedValue({
        user: { id: "new-user-123" },
      });
      mockUserRepository.update.mockResolvedValue(undefined);

      const result = await AdminService.initializeOwner(
        "owner@example.com",
        "password",
      );

      expect(result).toEqual({ userId: "new-user-123" });
      expect(mockUserRepository.update).toHaveBeenCalledWith("new-user-123", {
        role: "owner",
        status: "active",
      });
    });

    it("throws error if signUp fails", async () => {
      mockUserRepository.findOwner.mockResolvedValue(undefined);
      mockSignUpEmail.mockResolvedValue({ user: null });

      await expect(
        AdminService.initializeOwner("owner@example.com", "password"),
      ).rejects.toThrow("Failed to create owner account");
    });
  });

  describe("deleteUser", () => {
    it("prevents self-deletion", async () => {
      await expect(
        AdminService.deleteUser("user-123", "user-123"),
      ).rejects.toThrow("Cannot delete your own account");
    });

    it("throws error if user not found", async () => {
      mockUserRepository.findById.mockResolvedValue(undefined);

      await expect(
        AdminService.deleteUser("target-user", "current-user"),
      ).rejects.toThrow("User not found");
    });

    it("prevents deletion of owner accounts", async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: "owner-user",
        role: "owner",
      } as any);

      await expect(
        AdminService.deleteUser("owner-user", "current-user"),
      ).rejects.toThrow("Cannot delete owner accounts");
    });

    it("successfully deletes non-owner user", async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: "member-user",
        role: "member",
      } as any);
      mockUserRepository.delete.mockResolvedValue(undefined);

      await expect(
        AdminService.deleteUser("member-user", "owner-user"),
      ).resolves.toBeUndefined();

      expect(mockUserRepository.delete).toHaveBeenCalledWith("member-user");
    });
  });

  describe("createInviteLink", () => {
    it("throws error if user already exists", async () => {
      mockUserRepository.findByEmail.mockResolvedValue({
        id: "existing-user",
        email: "existing@example.com",
      } as NonNullable<
        Awaited<ReturnType<typeof mockUserRepository.findByEmail>>
      >);

      await expect(
        AdminService.createInviteLink("existing@example.com"),
      ).rejects.toThrow("A user with this email already exists");
    });

    it("creates pending user with member role", async () => {
      mockUserRepository.findByEmail.mockResolvedValue(undefined);
      mockSignUpEmail.mockResolvedValue({
        user: { id: "new-user-123" },
      });
      mockUserRepository.update.mockResolvedValue(undefined);
      mockTokenVerificationRepository.create.mockResolvedValue(undefined);

      const result = await AdminService.createInviteLink("new@example.com");

      expect(result.userId).toBe("new-user-123");
      expect(result.inviteUrl).toContain("https://gateway.example.com");
      expect(result.inviteUrl).toContain("/accept-invitation");
      expect(result.inviteUrl).toContain("token=");

      expect(mockUserRepository.update).toHaveBeenCalledWith("new-user-123", {
        status: "pending",
        role: "member",
      });
    });
  });

  describe("regenerateInviteLink", () => {
    it("throws error if user not found", async () => {
      mockUserRepository.findById.mockResolvedValue(undefined);

      await expect(
        AdminService.regenerateInviteLink("non-existent-user"),
      ).rejects.toThrow("User not found");
    });

    it("throws error if user is not pending", async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: "active-user",
        email: "active@example.com",
        status: "active",
      } as any);

      await expect(
        AdminService.regenerateInviteLink("active-user"),
      ).rejects.toThrow("Can only regenerate invite links for pending users");
    });

    it("deletes old tokens and creates new invite link", async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: "pending-user",
        email: "pending@example.com",
        status: "pending",
      } as any);
      mockTokenVerificationRepository.deleteByIdentifier.mockResolvedValue(
        undefined,
      );
      mockTokenVerificationRepository.create.mockResolvedValue(undefined);

      const result = await AdminService.regenerateInviteLink("pending-user");

      expect(result.inviteUrl).toContain("https://gateway.example.com");
      expect(result.inviteUrl).toContain("/accept-invitation");
      expect(
        mockTokenVerificationRepository.deleteByIdentifier,
      ).toHaveBeenCalledWith("pending@example.com");
    });
  });

  describe("createPasswordResetLink", () => {
    it("throws error if user not found", async () => {
      mockUserRepository.findById.mockResolvedValue(undefined);

      await expect(
        AdminService.createPasswordResetLink("non-existent-user"),
      ).rejects.toThrow("User not found");
    });

    it("throws error if user is not active", async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: "pending-user",
        email: "pending@example.com",
        status: "pending",
      } as any);

      await expect(
        AdminService.createPasswordResetLink("pending-user"),
      ).rejects.toThrow(
        "Can only generate password reset links for active users",
      );
    });

    it("creates reset link for active user", async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: "active-user",
        email: "active@example.com",
        status: "active",
      } as any);
      mockTokenVerificationRepository.create.mockResolvedValue(undefined);

      const result = await AdminService.createPasswordResetLink("active-user");

      expect(result.resetUrl).toContain("https://gateway.example.com");
      expect(result.resetUrl).toContain("/reset-password");
      expect(result.resetUrl).toContain("token=");
    });
  });

  describe("hasOwner", () => {
    it("returns true when owner exists", async () => {
      mockUserRepository.findOwner.mockResolvedValue({
        id: "owner-123",
        role: "owner",
      } as NonNullable<
        Awaited<ReturnType<typeof mockUserRepository.findOwner>>
      >);

      const result = await AdminService.hasOwner();

      expect(result).toEqual({ hasOwner: true });
    });

    it("returns false when no owner exists", async () => {
      mockUserRepository.findOwner.mockResolvedValue(undefined);

      const result = await AdminService.hasOwner();

      expect(result).toEqual({ hasOwner: false });
    });
  });

  describe("listUsers", () => {
    it("returns all users", async () => {
      const mockUsers = [
        { id: "user-1", email: "user1@example.com" },
        { id: "user-2", email: "user2@example.com" },
      ];
      mockUserRepository.findAllForList.mockResolvedValue(mockUsers as any);

      const result = await AdminService.listUsers();

      expect(result).toEqual({ users: mockUsers });
    });
  });
});
