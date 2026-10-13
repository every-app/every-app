import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredApp } from "@every-app/perimeter";

const { mockMemberFindFirst, mockUserFindFirst } = vi.hoisted(() => ({
  mockMemberFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...parts: unknown[]) => ({ type: "and", parts })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: "eq", left, right })),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      users: {
        findFirst: mockUserFindFirst,
      },
    },
    // resolveLiveOrgRole: the membership joined with the user's ban state.
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => {
              const row = await mockMemberFindFirst();
              return row ? [{ banned: false, banExpires: null, ...row }] : [];
            },
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  members: {
    userId: "members.user_id",
    organizationId: "members.organization_id",
  },
  users: {
    id: "users.id",
  },
}));

vi.mock("@/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock("@/server/services/UserPatService", () => ({
  UserPatService: {
    verify: vi.fn(),
  },
}));

vi.mock("@/server/repositories/UserPatRepository", () => ({
  UserPatRepository: {
    touchLastUsed: vi.fn(),
  },
}));

vi.mock("@/server/repositories/AppAccessRepository", () => ({
  AppAccessRepository: {
    hasAccessByUserAndAppSlug: vi.fn(),
  },
}));

vi.mock("@/server/repositories/AppRepository", () => ({
  AppRepository: {
    findByAppSlug: vi.fn(),
  },
}));

import { auth } from "@/auth";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { AppRepository } from "@/server/repositories/AppRepository";
import { UserPatRepository } from "@/server/repositories/UserPatRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { createProdAuthenticator } from "./betterAuthAuthenticator";

const mockAuth = vi.mocked(auth);
const mockAppAccessRepository = vi.mocked(AppAccessRepository);
const mockAppRepository = vi.mocked(AppRepository);
const mockUserPatRepository = vi.mocked(UserPatRepository);
const mockUserPatService = vi.mocked(UserPatService);

const APP: RegisteredApp = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo",
  tier: "service_binding",
  organizationId: "org-id",
  status: "active",
  manifest: { id: "todo" },
};

function request(token = "epat_valid"): Request {
  return new Request("https://todo.example.com/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function activePat(overrides: Record<string, unknown> = {}) {
  return {
    id: "pat-id",
    userId: "user-id",
    userEmail: "user@example.com",
    organizationId: "org-id",
    appRowId: null,
    scopes: ["mcp:read"],
    ...overrides,
  } as Awaited<ReturnType<typeof UserPatService.verify>>;
}

describe("createProdAuthenticator PAT branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserPatRepository.touchLastUsed.mockResolvedValue(undefined);
    mockMemberFindFirst.mockResolvedValue({
      organizationId: "org-id",
      role: "member",
    });
    mockUserFindFirst.mockResolvedValue({
      id: "user-id",
      email: "user@example.com",
    });
  });

  it("authenticates a valid PAT with credential fields", async () => {
    mockUserPatService.verify.mockResolvedValue(activePat());

    const session = await createProdAuthenticator().authenticate(request());

    expect(session).toMatchObject({
      sub: "user-id",
      email: "user@example.com",
      orgId: "org-id",
      orgRole: "member",
      credential: {
        kind: "pat",
        channel: "api",
        actor: "pat:pat-id",
        scopes: ["mcp:read"],
      },
    });
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();
    expect(mockUserPatRepository.touchLastUsed).toHaveBeenCalledWith(
      "pat-id",
      "user-id",
    );
  });

  it.each(["unknown", "revoked", "expired"])(
    "returns null for %s epat credentials without falling through to cookies",
    async () => {
      mockUserPatService.verify.mockResolvedValue(null);

      await expect(
        createProdAuthenticator().authenticate(request("epat_bad")),
      ).resolves.toBeNull();
      expect(mockAuth.api.getSession).not.toHaveBeenCalled();
    },
  );

  it("rejects the PAT of a deactivated (banned) user", async () => {
    mockUserPatService.verify.mockResolvedValue(activePat());
    mockMemberFindFirst.mockResolvedValue({
      organizationId: "org-id",
      role: "member",
      banned: true,
    });

    await expect(
      createProdAuthenticator().authenticate(request()),
    ).resolves.toBeNull();
  });

  it("returns null when the token user is no longer a member of the token org", async () => {
    mockUserPatService.verify.mockResolvedValue(activePat());
    mockMemberFindFirst.mockResolvedValue(undefined);

    await expect(
      createProdAuthenticator().authenticate(request()),
    ).resolves.toBeNull();
  });

  it("allows an app-scoped PAT for the matching served app", async () => {
    mockUserPatService.verify.mockResolvedValue(
      activePat({ appRowId: "app-row-1" }),
    );
    const patSession = await createProdAuthenticator().authenticate(request());
    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "app-row-1",
    } as any);
    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockResolvedValue(true);

    await expect(
      createProdAuthenticator().hasAppAccess(patSession!, APP),
    ).resolves.toBe(true);
  });

  it("denies an app-scoped PAT for a different app in the same org", async () => {
    mockUserPatService.verify.mockResolvedValue(
      activePat({ appRowId: "app-row-1" }),
    );
    const session = await createProdAuthenticator().authenticate(request());
    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "app-row-2",
    } as any);

    await expect(
      createProdAuthenticator().hasAppAccess(session!, APP),
    ).resolves.toBe(false);
    expect(
      mockAppAccessRepository.hasAccessByUserAndAppSlug,
    ).not.toHaveBeenCalled();
  });
});

describe("createProdAuthenticator with other bearers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts no bearer but a personal access token on an app host", async () => {
    // OAuth access tokens are for the gateway's own /mcp: an app host
    // refuses them (and anything else) without falling back to the cookie.
    for (const token of ["user-id:grant-id:secret", "eyJhbGciOi.x.y", "abc"]) {
      await expect(
        createProdAuthenticator().authenticate(request(token)),
      ).resolves.toBeNull();
    }
    expect(mockUserPatService.verify).not.toHaveBeenCalled();
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();
  });
});
