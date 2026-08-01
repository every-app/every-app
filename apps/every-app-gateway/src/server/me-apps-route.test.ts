import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

const mockResolveOrgContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/organization/orgContext", () => ({
  resolveOrgContext: mockResolveOrgContext,
}));

const mockGetAppsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/AppAccessService", () => ({
  AppAccessService: {
    getAppsForUser: mockGetAppsForUser,
  },
}));

import { Route as MeAppsRoute } from "@/routes/api/me/apps";

function getHandler() {
  return (MeAppsRoute as any).options.server.handlers.GET as (ctx: {
    request: Request;
  }) => Promise<Response>;
}

function makeRequest(): Request {
  return new Request("https://gateway.example.com/api/me/apps", {
    headers: { cookie: "better-auth.session_token=abc" },
  });
}

describe("GET /api/me/apps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await getHandler()({ request: makeRequest() });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockGetAppsForUser).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no organization", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: null },
    });
    mockResolveOrgContext.mockResolvedValue(null);

    const response = await getHandler()({ request: makeRequest() });

    expect(response.status).toBe(401);
    expect(mockGetAppsForUser).not.toHaveBeenCalled();
  });

  it("returns the user's launchable apps", async () => {
    const org = { orgId: "org-1", userId: "user-1", role: "member" };
    mockGetSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-1" },
    });
    mockResolveOrgContext.mockResolvedValue(org);
    mockGetAppsForUser.mockResolvedValue({
      apps: [
        {
          id: "row-1",
          organizationId: "org-1",
          appId: "todo",
          name: "Todo",
          description: "A todo app",
          hostname: "todo.example.com",
          status: "active",
          isDefault: true,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          grantedAt: new Date("2026-01-02T00:00:00Z"),
        },
      ],
    });

    const response = await getHandler()({ request: makeRequest() });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(mockResolveOrgContext).toHaveBeenCalledWith({
      userId: "user-1",
      activeOrganizationId: "org-1",
    });
    expect(mockGetAppsForUser).toHaveBeenCalledWith(org);

    const body = (await response.json()) as { apps: Array<any> };
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]).toMatchObject({
      appId: "todo",
      hostname: "todo.example.com",
      status: "active",
      grantedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("filters out apps without a routing hostname", async () => {
    const org = { orgId: "org-1", userId: "user-1", role: "member" };
    mockGetSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-1" },
    });
    mockResolveOrgContext.mockResolvedValue(org);
    mockGetAppsForUser.mockResolvedValue({
      apps: [
        { appId: "deployed", hostname: "deployed.example.com" },
        { appId: "registered-only", hostname: null },
      ],
    });

    const response = await getHandler()({ request: makeRequest() });

    const body = (await response.json()) as { apps: Array<any> };
    expect(body.apps.map((app) => app.appId)).toEqual(["deployed"]);
  });
});
