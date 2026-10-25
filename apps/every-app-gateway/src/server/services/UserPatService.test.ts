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

// The token events ride the bus; the bus and its lookups read D1, which
// this test doesn't have. What they are told is pinned here.
vi.mock("@/server/events/bus", () => ({ emit: vi.fn() }));
vi.mock("@/server/events/subjects", () => ({
  userActor: vi.fn(async (id: string) => ({ kind: "user", id })),
  userSubject: vi.fn(async (id: string) => ({ id, email: null, name: null })),
}));

const workerEnv = vi.hoisted(
  () =>
    ({ BETTER_AUTH_SECRET: "test-secret" }) as Record<
      string,
      string | undefined
    >,
);
vi.mock("cloudflare:workers", () => ({ env: workerEnv }));

import { emit } from "@/server/events/bus";
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
    // token.created names the row, never the value or its hash
    // (events.no-secrets-no-tool-io).
    expect(emit).toHaveBeenCalledTimes(1);
    // The subjects are looked up inside the bus's guard: emit got a builder.
    const built = vi.mocked(emit).mock.calls[0]![0];
    const event = typeof built === "function" ? await built() : built;
    expect(event).toMatchObject({
      organizationId: "org-id",
      type: "token.created",
      data: { name: "Claude", scopes: ["mcp:read"], appId: "todo" },
    });
    expect(JSON.stringify(event)).not.toContain(created.plaintext);
    expect(JSON.stringify(event)).not.toContain("token-hash");
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

  describe("deploy keys", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    beforeEach(() => {
      mockHashUserPat.mockResolvedValue("token-hash");
      mockUserPatRepository.create.mockResolvedValue(undefined);
      mockUserPatRepository.findByIdForUser.mockResolvedValue({
        id: "token-id",
      } as any);
      workerEnv["GATEWAY_DEPLOYMENT_MODE"] = "hosted";
      workerEnv["THIRD_PARTY_DEPLOYS"] = "on";
    });

    const createDeployKey = (scopes = ["deploy"]) =>
      UserPatService.create({
        userId: "user-id",
        organizationId: "org-id",
        name: "CI",
        scopes,
      });

    it("makes a deploy key last 30 days unless told otherwise", async () => {
      await createDeployKey();
      const [stored] = mockUserPatRepository.create.mock.calls[0]!;
      expect(stored.scopes).toEqual(["deploy"]);
      const ttl = stored.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(29 * DAY_MS);
      expect(ttl).toBeLessThanOrEqual(30 * DAY_MS);
    });

    it("refuses a deploy key with any other scope", async () => {
      await expect(
        createDeployKey(["deploy", "mcp:read"]),
      ).rejects.toMatchObject({ code: "INVALID_TOKEN_SCOPE" });
    });

    it("makes no deploy key where third-party deploys are off", async () => {
      for (const gate of [
        { GATEWAY_DEPLOYMENT_MODE: "hosted", THIRD_PARTY_DEPLOYS: undefined },
        { GATEWAY_DEPLOYMENT_MODE: "self_hosted", THIRD_PARTY_DEPLOYS: "on" },
      ]) {
        Object.assign(workerEnv, gate);
        await expect(createDeployKey()).rejects.toMatchObject({
          code: "DEPLOY_KEYS_UNAVAILABLE",
        });
      }
      expect(mockUserPatRepository.create).not.toHaveBeenCalled();
    });
  });
});
