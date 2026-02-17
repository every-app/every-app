import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/AppRepository", () => ({
  AppRepository: {
    findById: vi.fn(),
  },
}));

vi.mock("../repositories/AppTokenRepository", () => ({
  AppTokenRepository: {
    findAllForAdmin: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
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
import { AppRepository } from "../repositories/AppRepository";
import { AppTokenRepository } from "../repositories/AppTokenRepository";
import { hashAppToken } from "../app-token-hash";

const mockAppRepository = vi.mocked(AppRepository);
const mockAppTokenRepository = vi.mocked(AppTokenRepository);
const mockHashAppToken = vi.mocked(hashAppToken);

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
          appId: "app-id",
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

      const result = await AppTokenService.list();
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]?.appSlug).toBe("chef");
    });
  });

  describe("create", () => {
    it("creates token with normalized scopes and returns plaintext token once", async () => {
      mockAppRepository.findById.mockResolvedValue({
        id: "app-id",
        appId: "chef",
        name: "Chef",
      } as any);
      mockHashAppToken.mockResolvedValue("token-hash");
      mockAppTokenRepository.create.mockResolvedValue(undefined);

      const result = await AppTokenService.create(
        {
          appId: "app-id",
          scopes: [" provider:OpenAI ", "provider:openai", "provider:*"],
          expiresAt: null,
        },
        "owner-id",
      );

      expect(result.token.startsWith("eat_")).toBe(true);
      expect(result.tokenPrefix).toBe(result.token.slice(0, 8));
      expect(result.scopes).toEqual(["provider:openai", "provider:*"]);
      expect(mockHashAppToken).toHaveBeenCalledWith(
        result.token,
        "test-secret",
      );
      expect(mockAppTokenRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "app-id",
          tokenHash: "token-hash",
          tokenPrefix: result.tokenPrefix,
          scopes: ["provider:openai", "provider:*"],
          createdBy: "owner-id",
        }),
      );
    });

    it("rejects unknown app", async () => {
      mockAppRepository.findById.mockResolvedValue(undefined);

      await expect(
        AppTokenService.create(
          {
            appId: "missing-app",
            scopes: ["provider:openai"],
            expiresAt: null,
          },
          "owner-id",
        ),
      ).rejects.toThrow("App not found");
    });

    it("allows system-created tokens without a creator user", async () => {
      mockAppRepository.findById.mockResolvedValue({
        id: "app-id",
        appId: "chef",
        name: "Chef",
      } as any);
      mockHashAppToken.mockResolvedValue("token-hash");
      mockAppTokenRepository.create.mockResolvedValue(undefined);

      await AppTokenService.create(
        {
          appId: "app-id",
          scopes: ["provider:openai"],
          expiresAt: null,
        },
        null,
      );

      expect(mockAppTokenRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: null,
        }),
      );
    });

    it("rejects invalid scopes", async () => {
      mockAppRepository.findById.mockResolvedValue({
        id: "app-id",
        appId: "chef",
        name: "Chef",
      } as any);

      await expect(
        AppTokenService.create(
          {
            appId: "app-id",
            scopes: ["read:all"],
            expiresAt: null,
          },
          "owner-id",
        ),
      ).rejects.toThrow("Invalid scope: read:all");
    });
  });

  describe("revoke", () => {
    it("revokes active token", async () => {
      mockAppTokenRepository.findById.mockResolvedValue({
        id: "token-id",
        revokedAt: null,
      } as any);
      mockAppTokenRepository.revoke.mockResolvedValue(undefined);

      const result = await AppTokenService.revoke("token-id");

      expect(result.alreadyRevoked).toBe(false);
      expect(mockAppTokenRepository.revoke).toHaveBeenCalledWith("token-id");
    });

    it("returns already revoked when token is revoked", async () => {
      mockAppTokenRepository.findById.mockResolvedValue({
        id: "token-id",
        revokedAt: new Date(),
      } as any);

      const result = await AppTokenService.revoke("token-id");

      expect(result.alreadyRevoked).toBe(true);
      expect(mockAppTokenRepository.revoke).not.toHaveBeenCalled();
    });

    it("throws when token does not exist", async () => {
      mockAppTokenRepository.findById.mockResolvedValue(null);

      await expect(AppTokenService.revoke("missing-token")).rejects.toThrow(
        "Token not found",
      );
    });
  });
});
