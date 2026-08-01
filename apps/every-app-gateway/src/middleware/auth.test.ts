import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveOrgContext, mockCreateMiddleware } = vi.hoisted(() => ({
  mockResolveOrgContext: vi.fn(),
  mockCreateMiddleware: vi.fn(() => {
    const middleware: Record<string, unknown> = {};
    middleware.middleware = vi.fn(() => middleware);
    middleware.server = vi.fn((handler: unknown) => {
      middleware.serverHandler = handler;
      return middleware;
    });
    return middleware;
  }),
}));

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: mockCreateMiddleware,
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
}));

vi.mock("@/auth", () => ({
  createAuth: vi.fn(),
}));

vi.mock("@/server/organization/orgContext", () => ({
  resolveOrgContext: (...args: unknown[]) => mockResolveOrgContext(...args),
}));

import {
  organizationAdminMiddleware,
  organizationMemberMiddleware,
  organizationOwnerMiddleware,
} from "./auth";

type MiddlewareHandler = (input: {
  next: ReturnType<typeof vi.fn>;
  context: Record<string, unknown>;
}) => Promise<unknown>;

const soleOrg = {
  orgId: "org-1",
  userId: "user-1",
  role: "owner",
} as const;

describe("organization middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a resolver-verified sole-org fallback", async () => {
    mockResolveOrgContext.mockResolvedValue(soleOrg);
    const next = vi.fn().mockResolvedValue("ok");

    await expect(
      memberHandler()({
        next,
        context: {
          user: { id: "user-1" },
          session: { activeOrganizationId: null },
        },
      }),
    ).resolves.toBe("ok");

    expect(mockResolveOrgContext).toHaveBeenCalledWith({
      userId: "user-1",
      activeOrganizationId: null,
    });
    expect(next).toHaveBeenCalledWith({
      context: expect.objectContaining({ org: soleOrg }),
    });
  });

  it("fails closed when the resolver cannot choose an organization", async () => {
    mockResolveOrgContext.mockResolvedValue(null);
    const next = vi.fn();

    await expect(
      memberHandler()({
        next,
        context: {
          user: { id: "user-1" },
          session: { activeOrganizationId: null },
        },
      }),
    ).rejects.toThrow("Unauthorized: Organization membership required");
    expect(next).not.toHaveBeenCalled();
  });

  it("allows admins through admin middleware", async () => {
    const next = vi.fn().mockResolvedValue("ok");

    await expect(
      adminHandler()({
        next,
        context: { org: { ...soleOrg, role: "admin" } },
      }),
    ).resolves.toBe("ok");
  });

  it("allows owners through admin middleware", async () => {
    const next = vi.fn().mockResolvedValue("ok");

    await expect(
      adminHandler()({ next, context: { org: soleOrg } }),
    ).resolves.toBe("ok");
  });

  it("rejects members from admin middleware", async () => {
    const next = vi.fn();

    await expect(
      adminHandler()({
        next,
        context: { org: { ...soleOrg, role: "member" } },
      }),
    ).rejects.toThrow("Unauthorized: Organization admin access required");
    expect(next).not.toHaveBeenCalled();
  });

  it("allows owners through owner middleware", async () => {
    const next = vi.fn().mockResolvedValue("ok");

    await expect(
      ownerHandler()({ next, context: { org: soleOrg } }),
    ).resolves.toBe("ok");
  });

  it("rejects non-owners from owner middleware", async () => {
    const next = vi.fn();

    await expect(
      ownerHandler()({
        next,
        context: { org: { ...soleOrg, role: "member" } },
      }),
    ).rejects.toThrow("Unauthorized: Organization owner access required");
    expect(next).not.toHaveBeenCalled();
  });
});

function memberHandler(): MiddlewareHandler {
  return (
    organizationMemberMiddleware as unknown as {
      serverHandler: MiddlewareHandler;
    }
  ).serverHandler;
}

function adminHandler(): MiddlewareHandler {
  return (
    organizationAdminMiddleware as unknown as {
      serverHandler: MiddlewareHandler;
    }
  ).serverHandler;
}

function ownerHandler(): MiddlewareHandler {
  return (
    organizationOwnerMiddleware as unknown as {
      serverHandler: MiddlewareHandler;
    }
  ).serverHandler;
}
