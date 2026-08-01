import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/AppTokenRepository", () => ({
  AppTokenRepository: {
    findAllForAdmin: vi.fn(),
    findActiveDeployByTokenHash: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
    touchLastUsed: vi.fn(),
  },
}));

vi.mock("../app-token-hash", () => ({
  hashAppToken: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret",
  },
}));

import { AppTokenService } from "./AppTokenService";
import { AppTokenRepository } from "../repositories/AppTokenRepository";
import { hashAppToken } from "../app-token-hash";

const mockAppTokenRepository = vi.mocked(AppTokenRepository);
const mockHashAppToken = vi.mocked(hashAppToken);
const ORG_ID = "org-123";

describe("AppTokenService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  describe("list", () => {
    it("returns tokens from repository", async () => {
      mockAppTokenRepository.findAllForAdmin.mockResolvedValue([
        {
          id: "token-id",
          appRowId: "app-id",
          appSlug: "chef",
          appName: "Chef",
          tokenPrefix: "eat_abcd",
          scopes: ["provider:openai"],
          createdAt: new Date(),
          updatedAt: new Date(),
          createdById: "owner-id",
          createdByEmail: "owner@example.com",
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        },
      ]);

      const result = await AppTokenService.list(ORG_ID);
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]?.appSlug).toBe("chef");
    });
  });

  describe("issueDeployToken", () => {
    it("creates an organization-scoped eak token", async () => {
      mockHashAppToken.mockResolvedValue("deploy-token-hash");
      mockAppTokenRepository.create.mockResolvedValue(undefined);

      const result = await AppTokenService.issueDeployToken({
        organizationId: ORG_ID,
        createdBy: "owner-id",
        expiresAt: null,
      });

      expect(result.token.startsWith("eak_")).toBe(true);
      expect(result.tokenPrefix).toBe(result.token.slice(0, 8));
      expect(result.appId).toBeNull();
      expect(result.scopes).toEqual(["apps:register", "apps:deploy"]);
      expect(mockHashAppToken).toHaveBeenCalledWith(
        result.token,
        "test-secret",
      );
      expect(mockAppTokenRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          appRowId: null,
          organizationId: ORG_ID,
          tokenHash: "deploy-token-hash",
          tokenPrefix: result.tokenPrefix,
          scopes: ["apps:register", "apps:deploy"],
          createdBy: "owner-id",
        }),
      );
    });
  });

  describe("verifyDeployToken", () => {
    it("verifies active deploy tokens and touches last-used", async () => {
      mockHashAppToken.mockResolvedValue("deploy-token-hash");
      mockAppTokenRepository.findActiveDeployByTokenHash.mockResolvedValue({
        id: "token-id",
        organizationId: ORG_ID,
        scopes: ["apps:register", "apps:deploy"],
      });
      mockAppTokenRepository.touchLastUsed.mockResolvedValue(undefined);

      const result = await AppTokenService.verifyDeployToken("eak_valid");

      expect(result).toEqual({
        organizationId: ORG_ID,
        scopes: ["apps:register", "apps:deploy"],
      });
      expect(
        mockAppTokenRepository.findActiveDeployByTokenHash,
      ).toHaveBeenCalledWith("deploy-token-hash");
      expect(mockAppTokenRepository.touchLastUsed).toHaveBeenCalledWith(
        "token-id",
        ORG_ID,
      );
    });

    it("rejects per-app tokens presented as deploy tokens", async () => {
      const result = await AppTokenService.verifyDeployToken("eat_valid");

      expect(result).toBeNull();
      expect(mockHashAppToken).not.toHaveBeenCalled();
      expect(
        mockAppTokenRepository.findActiveDeployByTokenHash,
      ).not.toHaveBeenCalled();
    });

    it("rejects hashed tokens that are not org-scoped deploy tokens", async () => {
      mockHashAppToken.mockResolvedValue("deploy-token-hash");
      mockAppTokenRepository.findActiveDeployByTokenHash.mockResolvedValue(
        null,
      );

      await expect(
        AppTokenService.verifyDeployToken("eak_per_app_hash"),
      ).resolves.toBeNull();
    });
  });

  describe("revoke", () => {
    it("revokes active token", async () => {
      mockAppTokenRepository.findById.mockResolvedValue({
        id: "token-id",
        revokedAt: null,
      } as any);
      mockAppTokenRepository.revoke.mockResolvedValue(undefined);

      const result = await AppTokenService.revoke("token-id", ORG_ID);

      expect(result.alreadyRevoked).toBe(false);
      expect(mockAppTokenRepository.revoke).toHaveBeenCalledWith(
        "token-id",
        ORG_ID,
      );
    });

    it("returns already revoked when token is revoked", async () => {
      mockAppTokenRepository.findById.mockResolvedValue({
        id: "token-id",
        revokedAt: new Date(),
      } as any);

      const result = await AppTokenService.revoke("token-id", ORG_ID);

      expect(result.alreadyRevoked).toBe(true);
      expect(mockAppTokenRepository.revoke).not.toHaveBeenCalled();
    });

    it("throws when token does not exist", async () => {
      mockAppTokenRepository.findById.mockResolvedValue(null);

      await expect(
        AppTokenService.revoke("missing-token", ORG_ID),
      ).rejects.toThrow("Token not found");
    });
  });
});
