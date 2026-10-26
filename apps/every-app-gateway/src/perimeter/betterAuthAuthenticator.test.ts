import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredApp } from "@every-app/perimeter";

const { mockMemberFindFirst, mockUserFindFirst, mockOrganizationFindFirst } =
  vi.hoisted(() => ({
    mockMemberFindFirst: vi.fn(),
    mockUserFindFirst: vi.fn(),
    // isOrganizationActive: the organization's status.
    mockOrganizationFindFirst: vi.fn(async () => ({ status: "active" })),
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
      organizations: {
        findFirst: mockOrganizationFindFirst,
      },
    },
    // resolveLiveMembership: the membership joined with the user's ban
    // state and the organization's name (two joins).
    select: () => {
      const joined = {
        innerJoin: () => joined,
        where: () => ({
          limit: async () => {
            const row = await mockMemberFindFirst();
            return row
              ? [{ banned: false, banExpires: null, orgName: "Acme", ...row }]
              : [];
          },
        }),
      };
      return { from: () => joined };
    },
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
  organizations: {
    id: "organizations.id",
  },
}));

vi.mock("@/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock("@/auth/cloudflare-access", () => ({
  prewarmOuterRingAssertion: vi.fn(),
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
import { SESSION_COOKIE_NAMES } from "@/auth/session-cookie";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { AppRepository } from "@/server/repositories/AppRepository";
import { UserPatRepository } from "@/server/repositories/UserPatRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { createProdAuthenticator } from "./betterAuthAuthenticator";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";

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
  scope: "org",
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
      orgName: "Acme",
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

  it("opens no app with a deploy key, an owner's included", async () => {
    mockUserPatService.verify.mockResolvedValue(
      activePat({ scopes: ["deploy"] }),
    );
    mockMemberFindFirst.mockResolvedValue({
      organizationId: "org-id",
      role: "owner",
    });

    await expect(
      createProdAuthenticator().authenticate(request()),
    ).resolves.toBeNull();
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();
  });

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

describe("createProdAuthenticator session cookie", () => {
  it("names the Better Auth session cookie, so the perimeter refuses a tossed copy", () => {
    expect(createProdAuthenticator().sessionCookieNames).toEqual(
      SESSION_COOKIE_NAMES,
    );
  });
});

describe("createProdAuthenticator with shared apps and suspended organizations", () => {
  // A first-party app the platform organization owns, opened with a token
  // of another organization.
  const SHARED: RegisteredApp = {
    ...APP,
    appId: "openseo",
    scope: "shared",
    organizationId: "platform-org",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearOrgContextCacheForTests();
    mockOrganizationFindFirst.mockResolvedValue({ status: "active" });
    mockMemberFindFirst.mockResolvedValue({ role: "member" });
    mockUserPatService.verify.mockResolvedValue(activePat());
  });

  it("lets any active organization's member into a shared app, acting under their own organization", async () => {
    const session = await createProdAuthenticator().authenticate(request());
    await expect(
      createProdAuthenticator({ sharedApps: true }).hasAppAccess(
        session!,
        SHARED,
      ),
    ).resolves.toBe(true);
    expect(
      mockAppAccessRepository.hasAccessByUserAndAppSlug,
    ).not.toHaveBeenCalled();
  });

  it("opens a shared app for nobody when the policy has no shared apps", async () => {
    const session = await createProdAuthenticator().authenticate(request());
    await expect(
      createProdAuthenticator().hasAppAccess(session!, SHARED),
    ).resolves.toBe(false);
  });

  it("refuses a token bound to another app on a shared app", async () => {
    mockUserPatService.verify.mockResolvedValue(
      activePat({ appRowId: "app-row-1" }),
    );
    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "shared-row",
    } as any);
    const session = await createProdAuthenticator().authenticate(request());
    await expect(
      createProdAuthenticator({ sharedApps: true }).hasAppAccess(
        session!,
        SHARED,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a suspended organization's token on its own apps and shared ones", async () => {
    mockOrganizationFindFirst.mockResolvedValue({ status: "suspended" });
    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockResolvedValue(true);
    const session = await createProdAuthenticator().authenticate(request());
    const authenticator = createProdAuthenticator({ sharedApps: true });
    await expect(authenticator.hasAppAccess(session!, APP)).resolves.toBe(
      false,
    );
    await expect(authenticator.hasAppAccess(session!, SHARED)).resolves.toBe(
      false,
    );
  });

  it("keeps a token to its own organization's apps", async () => {
    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockResolvedValue(true);
    const session = await createProdAuthenticator().authenticate(request());
    await expect(
      createProdAuthenticator().hasAppAccess(session!, {
        ...APP,
        organizationId: "other-org",
      }),
    ).resolves.toBe(false);
    expect(
      mockAppAccessRepository.hasAccessByUserAndAppSlug,
    ).not.toHaveBeenCalled();
  });

  it("asks the organization's status and the access row together, and needs both", async () => {
    // One round trip instead of two in a row: the reads start before
    // either has answered, and the answer is the same as asking in turn.
    const order: string[] = [];
    mockOrganizationFindFirst.mockImplementation(async () => {
      order.push("status asked");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("status answered");
      return { status: "active" };
    });
    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockImplementation(
      async () => {
        order.push("access asked");
        return true;
      },
    );
    const session = await createProdAuthenticator().authenticate(request());
    await expect(
      createProdAuthenticator().hasAppAccess(session!, APP),
    ).resolves.toBe(true);
    expect(order).toEqual(["status asked", "access asked", "status answered"]);

    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockResolvedValue(false);
    await expect(
      createProdAuthenticator().hasAppAccess(session!, APP),
    ).resolves.toBe(false);
    clearOrgContextCacheForTests();
    mockOrganizationFindFirst.mockResolvedValue({ status: "suspended" });
    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockResolvedValue(true);
    await expect(
      createProdAuthenticator().hasAppAccess(session!, APP),
    ).resolves.toBe(false);
  });
});
