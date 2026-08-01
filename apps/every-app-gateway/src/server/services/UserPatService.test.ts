import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/AppRepository", () => ({
  AppRepository: {
    findById: vi.fn(),
  },
}));

vi.mock("../repositories/UserPatRepository", () => ({
  UserPatRepository: {
    findActiveByTokenHash: vi.fn(),
    findByIdForUser: vi.fn(),
    listForUser: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("../user-pat-hash", () => ({
  hashUserPat: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret",
  },
}));

import { AppRepository } from "../repositories/AppRepository";
import { UserPatRepository } from "../repositories/UserPatRepository";
import { hashUserPat } from "../user-pat-hash";
import { UserPatService } from "./UserPatService";

const mockAppRepository = vi.mocked(AppRepository);
const mockUserPatRepository = vi.mocked(UserPatRepository);
const mockHashUserPat = vi.mocked(hashUserPat);

describe("UserPatService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  it("creates and verifies a PAT roundtrip", async () => {
    mockHashUserPat.mockResolvedValue("token-hash");
    mockAppRepository.findById.mockResolvedValue({
      id: "app-id",
      appSlug: "todo",
      name: "Todo",
    } as any);
    mockUserPatRepository.create.mockResolvedValue(undefined);
    mockUserPatRepository.findByIdForUser.mockResolvedValue({
      id: "token-id",
      userId: "user-id",
      userEmail: "user@example.com",
      organizationId: "org-id",
      appRowId: "app-id",
      appSlug: "todo",
      appName: "Todo",
      name: "Claude",
      tokenPrefix: "epat_abcd",
      scopes: ["mcp:read"],
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 90_000),
      revokedAt: null,
      lastUsedAt: null,
    });
    mockUserPatRepository.findActiveByTokenHash.mockResolvedValue({
      id: "token-id",
      userId: "user-id",
      userEmail: "user@example.com",
      organizationId: "org-id",
      appRowId: "app-id",
      scopes: ["mcp:read"],
    });

    const created = await UserPatService.create({
      userId: "user-id",
      organizationId: "org-id",
      appRowId: "app-id",
      name: "Claude",
      scopes: ["mcp:read"],
    });
    const verified = await UserPatService.verify(created.plaintext);

    expect(created.plaintext).toMatch(/^epat_[a-f0-9]{64}$/);
    expect(created.row.appId).toBe("app-id");
    expect(mockHashUserPat).toHaveBeenCalledWith(
      created.plaintext,
      "test-secret",
    );
    expect(verified?.id).toBe("token-id");
  });

  it("returns null for expired tokens", async () => {
    mockHashUserPat.mockResolvedValue("token-hash");
    mockUserPatRepository.findActiveByTokenHash.mockResolvedValue(null);

    await expect(UserPatService.verify("epat_expired")).resolves.toBeNull();
  });

  it("returns null for revoked tokens", async () => {
    mockHashUserPat.mockResolvedValue("token-hash");
    mockUserPatRepository.findActiveByTokenHash.mockResolvedValue(null);

    await expect(UserPatService.verify("epat_revoked")).resolves.toBeNull();
  });

  it("returns null for a tampered secret", async () => {
    mockHashUserPat.mockResolvedValue("different-hash");
    mockUserPatRepository.findActiveByTokenHash.mockResolvedValue(null);

    await expect(UserPatService.verify("epat_tampered")).resolves.toBeNull();
  });

  it("returns null for the wrong prefix", async () => {
    await expect(UserPatService.verify("eat_wrong")).resolves.toBeNull();

    expect(mockHashUserPat).not.toHaveBeenCalled();
  });
});
