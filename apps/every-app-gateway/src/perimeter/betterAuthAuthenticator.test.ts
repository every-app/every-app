import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredApp } from "@every-app/perimeter";

const {
  mockMemberFindFirst,
  mockUserFindFirst,
  mockOrganizationFindFirst,
  mockValidateToken,
  mockOauthEnabled,
  mockResolveNativeCaller,
} = vi.hoisted(() => ({
  mockMemberFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
  // isOrganizationActive: the organization's status.
  mockOrganizationFindFirst: vi.fn(async () => ({ status: "active" })),
  // The OAuth server's validateAppHostToken and the native caller's
  // re-read (server/mcp-auth), native sign-in.
  mockValidateToken: vi.fn(),
  mockOauthEnabled: vi.fn(() => true),
  mockResolveNativeCaller: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));

vi.mock("@/server/mcp-auth/config", () => ({
  validateAppHostToken: mockValidateToken,
}));

vi.mock("@/server/mcp-auth/validate", () => ({
  resolveNativeCaller: mockResolveNativeCaller,
}));

vi.mock("@/server/oauth-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/oauth-flag")>()),
  isMcpOauthEnabled: mockOauthEnabled,
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

describe("createProdAuthenticator with a native token (Sign in with Every App)", () => {
  /** A token of the gateway's OAuth server, by shape. */
  const TOKEN = `user-id:${"g".repeat(16)}:${"s".repeat(32)}`;
  const THIS_HOST = "https://todo.example.com";
  const PROPS = {
    v: 1,
    kind: "native",
    connectionId: "mcpc_1",
    userId: "user-id",
    organizationId: "org-id",
    appRowId: "app-row-1",
  };
  const CALLER = {
    connectionId: "mcpc_1",
    userId: "user-id",
    email: "user@example.com",
    organizationId: "org-id",
    organizationName: "Acme",
    orgRole: "member",
    appRowId: "app-row-1",
    clientName: "OpenZen for Mac",
    clientDomain: null,
  };
  /** The server validates a token for exactly its audience. */
  function validFor(audience: string, props: unknown = PROPS) {
    mockValidateToken.mockImplementation(
      async (_env: unknown, resource: string) =>
        resource === audience
          ? {
              props,
              audience,
              expiresAt: Date.now() + 3_600_000,
              scope: ["*"],
              userId: "user-id",
              clientId: "client_1",
            }
          : null,
    );
  }
  function on(host: string, path = "/api/tasks"): Request {
    return new Request(`https://${host}${path}`, {
      headers: { host, authorization: `Bearer ${TOKEN}` },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearOrgContextCacheForTests();
    mockOauthEnabled.mockReturnValue(true);
    mockOrganizationFindFirst.mockResolvedValue({ status: "active" });
    mockResolveNativeCaller.mockResolvedValue(CALLER);
    validFor(THIS_HOST);
  });

  it("validates it for this host and acts as the member, on the api channel, bound to its app", async () => {
    const session = await createProdAuthenticator().authenticate(
      on("todo.example.com"),
    );
    expect(mockValidateToken).toHaveBeenCalledWith(
      expect.anything(),
      THIS_HOST,
      TOKEN,
    );
    expect(mockResolveNativeCaller).toHaveBeenCalledWith(PROPS);
    expect(session).toEqual({
      sub: "user-id",
      email: "user@example.com",
      orgId: "org-id",
      orgRole: "member",
      orgName: "Acme",
      credential: {
        kind: "oauth",
        channel: "api",
        actor: "oauth:mcpc_1",
        scopes: ["*"],
      },
      credentialAppRowId: "app-row-1",
      credentialAudience: THIS_HOST,
    });
    expect(mockUserPatService.verify).not.toHaveBeenCalled();
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();

    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "app-row-1",
    } as any);
    mockAppAccessRepository.hasAccessByUserAndAppSlug.mockResolvedValue(true);
    await expect(
      createProdAuthenticator().hasAppAccess(session!, APP),
    ).resolves.toBe(true);
  });

  it("refuses it on another host: the audience is one app's origin", async () => {
    // The server answers null for any other resource (another app host,
    // the gateway's own /mcp), and the request fails closed, never
    // anonymous.
    await expect(
      createProdAuthenticator().authenticate(on("notes.example.com")),
    ).resolves.toBeNull();
    expect(mockValidateToken).toHaveBeenCalledWith(
      expect.anything(),
      "https://notes.example.com",
      TOKEN,
    );
    expect(mockResolveNativeCaller).not.toHaveBeenCalled();
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();
  });

  it("refuses it on an app whose row or hostname isn't the grant's, even once validated", async () => {
    const session = await createProdAuthenticator().authenticate(
      on("todo.example.com"),
    );
    // Another row under the same id and organization (belt and braces).
    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "app-row-2",
    } as any);
    await expect(
      createProdAuthenticator().hasAppAccess(session!, APP),
    ).resolves.toBe(false);
    // The served app's registered hostname isn't the audience.
    mockAppRepository.findByAppSlug.mockResolvedValue({
      id: "app-row-1",
    } as any);
    await expect(
      createProdAuthenticator().hasAppAccess(session!, {
        ...APP,
        hostname: "notes.example.com",
      }),
    ).resolves.toBe(false);
    expect(
      mockAppAccessRepository.hasAccessByUserAndAppSlug,
    ).not.toHaveBeenCalled();
  });

  it("fails closed when the connection no longer stands (revoked, removed, deactivated, suspended, another grant's app)", async () => {
    // resolveNativeCaller (server/mcp-auth/validate.ts) answers null for
    // every one of those, and for an /mcp grant's props; the perimeter
    // never turns that into anonymous access.
    mockResolveNativeCaller.mockResolvedValue(null);
    await expect(
      createProdAuthenticator().authenticate(on("todo.example.com")),
    ).resolves.toBeNull();
    expect(mockResolveNativeCaller).toHaveBeenCalledWith(PROPS);
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();
  });

  it("opens nothing while OAuth is off, or when the server can't validate", async () => {
    mockOauthEnabled.mockReturnValue(false);
    await expect(
      createProdAuthenticator().authenticate(on("todo.example.com")),
    ).resolves.toBeNull();
    expect(mockValidateToken).not.toHaveBeenCalled();

    mockOauthEnabled.mockReturnValue(true);
    mockValidateToken.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      createProdAuthenticator().authenticate(on("todo.example.com")),
    ).resolves.toBeNull();
    expect(mockResolveNativeCaller).not.toHaveBeenCalled();
    expect(mockAuth.api.getSession).not.toHaveBeenCalled();
  });
});
